// The panel under the garden: purse, diary ticker, tabs and the things to buy.
// Rows are rebuilt only when the list of them changes; otherwise their text is
// refreshed in place a few times a second.
import type { Game } from '../sim/game.ts';
import {
  ABILITIES, FLOWERS, GNOMES, HEIRLOOMS, TASK, TUNE, UPGRADES, UNEARTH_DEPTH, type Cost, type Res, type Tab,
} from '../sim/content.ts';
import {
  addCost, canAfford, gnomeCost, metreEffort, plotCost, totalGnomes, unearthCost, upgradeCap, upgradeCost, upgradeNeeds, hatsFor,
} from '../sim/economy.ts';
import { MAX_PLOTS } from '../sim/world.ts';
import { clamp, fmt, fmtTime, lerp, mood } from '../util.ts';
import type { Frame } from '../render/fb.ts';
import * as S from '../render/sprites.ts';

// ---------------------------------------------------------------- icons from sprites

const iconCache = new Map<Frame, string>();

function icon(f: Frame): string {
  let url = iconCache.get(f);
  if (!url) {
    const c = document.createElement('canvas');
    const side = Math.max(f.w, f.h) + 2;
    c.width = side; c.height = side;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(f.w, f.h);
    new Uint32Array(img.data.buffer).set(f.px);
    ctx.putImageData(img, (side - f.w) >> 1, (side - f.h) >> 1);
    url = c.toDataURL();
    iconCache.set(f, url);
  }
  return url;
}

const dot = (color: string, shape: string[]): Frame => {
  const n = parseInt(color.slice(1), 16);
  const c = ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | ((n >> 16) & 255)) >>> 0;
  const w = shape[0].length;
  const px = new Uint32Array(w * shape.length);
  shape.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') px[y * w + x] = ch === 'k' ? 0xff22171f : c; }));
  return { w, h: shape.length, px };
};

const ICON = {
  tooth: dot('#fdf9ee', ['.kkkkk.', 'k#####k', 'k#####k', 'k#####k', 'k##k##k', 'k#k.k#k', '.k...k.']),
  pebble: dot('#d9d4c8', ['..kkk..', '.k###k.', 'k#####k', 'k#####k', '.k###k.', '..kkk..']),
  whisper: dot('#b58cf0', ['.kkkkk.', 'k#####k', 'k#k#k#k', 'k#####k', '.kk#kk.', '..k#k..', '...k...']),
  hat: dot('#d5392f', ['...k...', '..k#k..', '..k#k..', '.k###k.', '.k###k.', 'k#####k', 'kkkkkkk']),
  plot: dot('#7d5030', ['........', '.kkkkkk.', 'k######k', 'k######k', '.kkkkkk.']),
  tool: dot('#aab0ba', ['.kkk..', 'k###k.', 'k###k.', '.k#k..', '.k#k..', '.k#k..', '.k#k..', '.kkk..']),
  rite: dot('#9a72d6', ['...k...', '..k#k..', '.k###k.', 'k##k##k', '.k###k.', '..k#k..', '...k...']),
  hole: dot('#1c1118', ['.kkkkkk.', 'k######k', 'k######k', '.kkkkkk.']),
};

const RES_NAME: Record<Res, string> = { blooms: 'blooms', teeth: 'teeth', whispers: 'whispers', hats: 'hats' };

// ---------------------------------------------------------------- rows

interface RowSpec {
  key: string;
  icon: string;
  name: string;
  note?: string;
  blurb: string;
  cost?: Cost;
  times?: number;          // how many this press buys
  label?: string;          // instead of a cost: "Owned", "Full"
  can: boolean;
  tone?: 'rite' | 'last';
  buy?: () => void;
}

interface Section { head?: string; meter?: { label: string; value: string; fill: number }; hint?: string; rows: RowSpec[] }

const TAB_NAMES: Record<Tab, string[]> = {
  garden: ['Garden'],
  todo: ['To do', 'To do', 'The list'],
  gnomes: ['Gnomes', 'Gnomes', 'Them'],
  below: ['The hole', 'The hole', 'Below'],
  rites: ['Rites'],
  hats: ['Heirlooms'],
  diary: ['Diary'],
};

const WHISPERS = ['WE SEE YOU', 'DIG', 'LET US IN', 'HE IS WAKING', 'COME DOWN', 'SO PLEASED', 'DO NOT STOP', 'ONE OF US'];

export interface UI {
  /** Refresh what is on screen. Call a few times a second. */
  update(): void;
  /** Show a diary line in the ticker. */
  say(text: string): void;
  /** A tab was unlocked or wants attention. */
  nudge(tab: Tab): void;
  modal(title: string, html: string, ok?: string, then?: () => void): void;
  openTab(tab: Tab): void;
  /** A short note over the garden that goes away by itself. */
  toast(html: string): void;
  /** The drawer was opened or closed: the garden may need to be measured again. */
  isOpen(): boolean;
}

export function createUI(g: Game, hooks: { onMute(): void; onReset(): void; onBuy(kind: 'buy' | 'rite' | 'no'): void; onAbility(id: string): void }): UI {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const title = $('title'), sub = $('sub');
  const peaceFill = $('peace-fill'), peaceNum = $('peace-num'), peaceLabel = $('peace-label');
  const purse = $('purse'), ticker = $('ticker'), tickerText = $('ticker-text');
  const tabs = $('tabs'), panel = $('panel'), skyNote = $('sky-note');
  const modalEl = $('modal'), modalTitle = $('modal-title'), modalBody = $('modal-body'), modalOk = $<HTMLButtonElement>('modal-ok');
  const cog = $('cog');
  const drawer = $('drawer'), abilities = $('abilities'), toastEl = $('toast');
  const handle = $('handle'), handleText = $('handle-text');
  let open = false;
  let abilitiesKey = '';
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  let tab: Tab = 'garden';
  let shownKey = '';
  let tabsKey = '';
  let purseKey = '';
  const fresh = new Set<Tab>();
  let typing = { full: '', at: 0 };
  let glitchUntil = 0;
  let afterModal: (() => void) | undefined;

  // ------------------------------------------------------------ costs

  const s = () => g.s;

  function resName(r: Res): string {
    if (r === 'teeth' && !s().flags.teethNamed) return 'pebbles';
    return RES_NAME[r];
  }

  function costText(c: Cost): string {
    const parts: string[] = [];
    for (const k of ['blooms', 'teeth', 'whispers', 'hats'] as Res[]) if (c[k]) parts.push(`${fmt(Math.ceil(c[k]!))} ${resName(k)}`);
    return parts.length ? parts.join('<br>') : 'Free';
  }

  /** How many a press buys, and what that costs, given the ×1 / ×10 / max switch. */
  function bulk(costAt: (extra: number) => Cost, most: number, affordable: number): { n: number; cost: Cost } {
    const want = s().buyN === 0 ? Math.max(1, affordable) : s().buyN;
    const n = Math.max(1, Math.min(want, most));
    let cost: Cost = {};
    for (let i = 0; i < n; i++) cost = addCost(cost, costAt(i));
    return { n, cost };
  }

  // ------------------------------------------------------------ what each tab holds

  function gardenTab(): Section {
    const st = s();
    const rows: RowSpec[] = [];
    if (st.flags.plots || st.plots > 4) {
      const full = st.plots >= MAX_PLOTS;
      const { n, cost } = full ? { n: 1, cost: {} } : bulk((e) => plotCost(st.plots + e), MAX_PLOTS - st.plots, g.maxPlots());
      rows.push({
        key: 'plot', icon: icon(S.ICONS.plot ?? ICON.plot), name: 'Dig a new bed', note: `${st.plots}/${MAX_PLOTS}`,
        blurb: mood(['One more patch of flowers.', 'One more patch of flowers.', 'More room for them to grow.'], st.peace),
        cost: full ? undefined : cost, times: n, label: full ? 'Full' : undefined, can: !full && canAfford(st, cost),
        buy: () => g.buyPlot(n),
      });
    }
    const next = FLOWERS[st.seed + 1];
    if (next) {
      const c = g.seedCost();
      if (c) {
        rows.push({
          key: 'seed' + st.seed, icon: icon(S.FLOWER[st.seed + 1].ripe[0]), name: `${next.name}`, note: 'new seeds',
          blurb: mood(next.blurb, st.peace) + ` Worth ${fmt(next.value / FLOWERS[st.seed].value)}× as much.`,
          cost: c, can: canAfford(st, c), buy: () => g.buySeed(),
        });
      } else if (st.flags.dig) {
        rows.push({
          key: 'seedwait' + st.seed, icon: icon(S.FLOWER[0].sprout), name: '???', note: 'new seeds',
          blurb: `Something else would grow here, if the hole were deeper. (${next.depth} m)`,
          label: `${st.depth}/${next.depth} m`, can: false,
        });
      }
    }
    for (const u of UPGRADES) if (u.tab === 'garden') pushUpgrade(rows, u.id);
    return { head: `Now growing: <b>${FLOWERS[st.seed].name}</b>`, rows };
  }

  function pushUpgrade(rows: RowSpec[], id: string) {
    const st = s();
    const u = UPGRADES.find((x) => x.id === id)!;
    const level = st.up[id] ?? 0;
    if (u.show && !u.show(st) && !level) return;
    const done = level >= u.max;
    const one = u.max === 1;
    // The garden can only take so much at once: further levels come as the hole deepens.
    const needs = upgradeNeeds(st, id);
    const { n, cost } = one || done || needs ? { n: 1, cost: upgradeCost(st, id) } : bulk((e) => upgradeCost(st, id, e), upgradeCap(st, id) - level, g.maxUpgrade(id));
    rows.push({
      key: 'up_' + id,
      icon: icon(S.ICONS[id] ?? (u.tab === 'rites' ? ICON.rite : u.tab === 'below' ? ICON.tooth : ICON.tool)),
      name: mood(u.names, st.peace), note: one ? undefined : `${level}/${u.max}`,
      blurb: mood(u.blurb, st.peace),
      cost: done || needs ? undefined : cost, times: n,
      label: done ? (one ? 'Done' : 'Full') : needs ? `<small>${st.flags.dig ? 'hole at' : 'later'}</small>${st.flags.dig ? needs + ' m' : '···'}` : undefined,
      can: !done && !needs && canAfford(st, cost), tone: u.tab === 'rites' ? 'rite' : undefined,
      buy: () => g.buyUpgrade(id, n),
    });
  }

  function gnomesTab(): Section {
    const st = s();
    const rows: RowSpec[] = [];
    for (const def of GNOMES) {
      if (!st.flags[def.flag]) continue;
      const { n, cost } = bulk((e) => gnomeCost(st, def.id, e), 500, g.maxGnomes(def.id));
      const look = def.id === 'gardener' ? 0 : def.id === 'digger' ? 3 : def.id === 'lantern' ? 4 : 2;
      const face = st.peace >= 70 ? 0 : st.peace >= 35 ? 1 : 2;
      rows.push({
        key: 'gnome_' + def.id, icon: icon(S.GNOME[look][face].stand),
        name: mood(def.names, st.peace), note: `${fmt(st.gnomes[def.id])}`,
        blurb: mood(def.blurb, st.peace),
        cost, times: n, can: canAfford(st, cost),
        buy: () => g.buyGnome(def.id, n),
      });
    }
    const total = totalGnomes(st);
    const bought = st.bought.gardener + st.bought.digger + st.bought.lantern + st.bought.choir;
    let head = `<b>${fmt(total)}</b> ${total === 1 ? 'gnome' : 'gnomes'} in the garden`;
    if (st.flags.friends && total > bought) head += ` · you bought <b>${fmt(bought)}</b>`;
    head += ` · flowers ×${fmt(Math.round(g.D.charm * 100) / 100)}`;
    return {
      head,
      hint: rows.length ? undefined : 'Nothing here yet. Just you and the daisies.',
      rows,
    };
  }

  function belowTab(): Section {
    const st = s();
    const rows: RowSpec[] = [];
    if (st.flags.teeth) for (const u of UPGRADES) if (u.tab === 'below') pushUpgrade(rows, u.id);
    const need = metreEffort(st.depth);
    return {
      meter: {
        label: mood(['The hole at the bottom of the lawn', 'The hole', 'The way down'], st.peace),
        value: `${st.depth} m`,
        fill: clamp(st.effort / need, 0, 1),
      },
      hint: st.flags.teeth ? undefined : 'The one with the shovel seems to know what he is doing.',
      rows,
    };
  }

  function ritesTab(): Section {
    const st = s();
    const rows: RowSpec[] = [];
    if (st.flags.unearth) {
      const c = unearthCost();
      rows.push({
        key: 'unearth', icon: icon(S.ICONS.unearth ?? ICON.hat), name: 'Let him up', tone: 'last',
        blurb: `He has waited so long. The garden ends; the hats go on to whoever comes next. (+${hatsFor(st.totalBlooms, st.depth)} red hats)`,
        cost: c, can: canAfford(st, c) && st.depth >= UNEARTH_DEPTH,
        buy: () => g.unearth(),
      });
    }
    for (const u of UPGRADES) if (u.tab === 'rites') pushUpgrade(rows, u.id);
    return { hint: 'The humming has words in it. Some of the words are things you could do.', rows };
  }

  function hatsTab(): Section {
    const st = s();
    const rows: RowSpec[] = HEIRLOOMS.map((hl) => ({
      key: 'heir_' + hl.id, icon: icon(S.ICONS.hat ?? ICON.hat), name: hl.name, blurb: hl.blurb,
      cost: st.heir[hl.id] ? undefined : { hats: hl.cost }, label: st.heir[hl.id] ? 'Kept' : undefined,
      can: !st.heir[hl.id] && st.hats >= hl.cost,
      buy: () => g.buyHeirloom(hl.id),
    }));
    return {
      head: `<b>${fmt(st.hatsEver)}</b> red hats handed down · everything ×${fmt(Math.round(g.D.hatMult * 100) / 100)}`,
      hint: `Owner number ${st.runs + 1}. Heirlooms stay in the house.`,
      rows,
    };
  }

  const tabsShown = (): Tab[] => {
    const st = s();
    const out: Tab[] = ['garden'];
    if (st.todo.length || st.done) out.push('todo');
    if (st.flags.gnomes) out.push('gnomes');
    if (st.flags.dig) out.push('below');
    if (st.flags.rites) out.push('rites');
    if (st.hatsEver > 0) out.push('hats');
    out.push('diary');
    return out;
  };

  function sectionFor(t: Tab): Section {
    return t === 'garden' ? gardenTab() : t === 'gnomes' ? gnomesTab() : t === 'below' ? belowTab()
      : t === 'rites' ? ritesTab() : t === 'hats' ? hatsTab() : { rows: [] };
  }

  // ------------------------------------------------------------ drawing the panel

  function rowHtml(r: RowSpec): string {
    return `<button class="row" data-key="${r.key}"><img alt="" src="${r.icon}"><span class="name"></span><span class="blurb"></span><span class="cost"></span></button>`;
  }

  function fillRow(el: HTMLElement, r: RowSpec, now: number) {
    el.className = 'row' + (r.label ? (r.label.includes('<small>') ? ' wait' : ' done') : r.can ? '' : ' poor') + (r.tone ? ' ' + r.tone : '');
    const name = el.children[1] as HTMLElement, blurb = el.children[2] as HTMLElement, cost = el.children[3] as HTMLElement;
    const img = el.children[0] as HTMLImageElement;
    if (img.getAttribute('src') !== r.icon) img.src = r.icon;
    if (now > glitchUntil || !name.dataset.glitch) {
      delete name.dataset.glitch;
      const html = esc(r.name) + (r.note ? `<i>${esc(r.note)}</i>` : '');
      if (name.innerHTML !== html) name.innerHTML = html;
    }
    if (blurb.textContent !== r.blurb) blurb.textContent = r.blurb;
    const c = r.label ?? ((r.times && r.times > 1 ? `<small>×${r.times}</small>` : '') + costText(r.cost ?? {}));
    if (cost.innerHTML !== c) cost.innerHTML = c;
  }

  function drawPanel(now: number) {
    if (tab === 'diary') return drawDiary();
    if (tab === 'todo') return drawTodo();
    const sec = sectionFor(tab);
    const amount = tab === 'gnomes' || tab === 'garden' || tab === 'below' || tab === 'rites';
    const key = tab + '|' + sec.rows.map((r) => r.key).join(',') + '|' + (sec.meter ? 'm' : '') + (sec.hint ? 'h' : '');
    if (key !== shownKey) {
      shownKey = key;
      panel.innerHTML =
        `<div class="head"><span class="head-text"></span>${amount ? '<span class="amount"><button data-n="1">×1</button><button data-n="10">×10</button><button data-n="0">Max</button></span>' : ''}</div>`
        + (sec.meter ? '<div class="meter"><div class="lbl"><span></span><b></b></div><div class="bar"><i></i></div></div>' : '')
        + (sec.hint ? '<p class="hint"></p>' : '')
        + sec.rows.map(rowHtml).join('');
      panel.scrollTop = 0;
    }
    const headText = panel.querySelector('.head-text') as HTMLElement;
    const h = sec.head ?? '';
    if (headText.innerHTML !== h) headText.innerHTML = h;
    panel.querySelectorAll<HTMLElement>('.amount button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === s().buyN));
    if (sec.meter) {
      const m = panel.querySelector('.meter') as HTMLElement;
      (m.querySelector('.lbl span') as HTMLElement).textContent = sec.meter.label;
      (m.querySelector('.lbl b') as HTMLElement).textContent = sec.meter.value;
      (m.querySelector('.bar i') as HTMLElement).style.width = `${(sec.meter.fill * 100).toFixed(1)}%`;
    }
    if (sec.hint) (panel.querySelector('.hint') as HTMLElement).textContent = sec.hint;
    const els = panel.querySelectorAll<HTMLElement>('.row');
    sec.rows.forEach((r, i) => fillRow(els[i], r, now));
    current = sec.rows;
  }

  /** The jobs on the list, as cards: how far along each is, and a button to collect on the finished ones. */
  function jobsHtml(): string {
    const st = s();
    return st.todo.map((t, i) => {
      const words = mood(TASK[t.kind].text, st.peace).replace('{n}', fmt(t.goal));
      const have = Math.min(t.have, t.goal);
      const side = t.ready
        ? `<button class="claim" data-claim="${i}">${esc(mood(['Cross off', 'Cross off', 'Done'], st.peace))}<small>+${fmt(Math.max(15 * g.D.bloomMult, st.rate.blooms * 45))} blooms</small></button>`
        : `<button class="skip" data-skip="${i}" aria-label="Swap this job">✕</button><span class="count">${fmt(have)} / ${fmt(t.goal)}</span>`;
      return `<div class="job${t.ready ? ' ready' : ''}">${side}<div class="what">${esc(words)}</div><div class="bar"><i style="width:${((have / t.goal) * 100).toFixed(1)}%"></i></div></div>`;
    }).join('');
  }

  const jobsHead = () => {
    const st = s();
    return `<b>${fmt(st.done)}</b> ${st.done === 1 ? 'job' : 'jobs'} crossed off · flowers ×${fmt(Math.round((1 + st.done * TUNE.economy.jobBonus) * 100) / 100)}`;
  };

  /** The to-do list: three jobs, each with how far along it is. */
  function drawTodo() {
    const st = s();
    current = [];
    const html = `<div class="head"><span class="head-text">${jobsHead()}</span></div>`
      + jobsHtml()
      + `<p class="hint">${esc(mood(['A list on the fridge. Cross a job off when it is done: each one makes every flower worth 2% more.', 'The list on the fridge. Some of it is in your handwriting.', 'the list. do what it says.'], st.peace))}</p>`;
    if (html !== shownKey) { shownKey = html; panel.innerHTML = html; }
  }

  let current: RowSpec[] = [];

  function drawDiary() {
    const st = s();
    current = [];
    // Today's page: what is still to do. Then everything written so far, newest first.
    const html = (st.todo.length ? `<div class="head"><span class="head-text">To do · ${jobsHead()}</span></div>` + jobsHtml() : '')
      + '<ul class="diary">'
      + [...st.log].reverse().map((l) => `<li class="${l.kind}"><small>Day ${l.day}${l.kind === 'job' ? ' · crossed off' : ''}</small>${esc(l.text)}</li>`).join('')
      + '</ul>'
      + `<p class="hint">Played ${fmtTime(st.stats.played)} · owner number ${st.runs + 1}</p>`;
    if (html !== shownKey) { shownKey = html; panel.innerHTML = html; }
  }

  panel.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const amount = target.closest<HTMLElement>('.amount button');
    if (amount) { s().buyN = Number(amount.dataset.n); update(); return; }
    if (target.dataset.skip) { g.skipTask(Number(target.dataset.skip)); update(); return; }
    const claim = target.closest<HTMLElement>('.claim');
    if (claim) { if (g.claimTask(Number(claim.dataset.claim))) hooks.onBuy('buy'); update(); return; }
    const el = target.closest<HTMLElement>('.row');
    if (!el) return;
    const r = current.find((x) => x.key === el.dataset.key);
    if (!r || !r.buy) return;
    if (!r.can) { hooks.onBuy('no'); return; }
    r.buy();
    hooks.onBuy(r.tone ? 'rite' : 'buy');
    update();
  });

  // ------------------------------------------------------------ tabs, purse, peace

  function drawTabs() {
    const st = s();
    const shown = tabsShown();
    if (!shown.includes(tab)) tab = 'garden';
    const key = shown.join(',') + '|' + tab + '|' + (st.peace >= 70 ? 0 : st.peace >= 35 ? 1 : 2) + '|' + open;
    if (key !== tabsKey) {
      tabsKey = key;
      tabs.innerHTML = shown.map((t) => `<button class="tab${t === tab ? ' on' : ''}" data-tab="${t}">${esc(mood(TAB_NAMES[t], st.peace))}</button>`).join('');
    }
    tabs.querySelectorAll<HTMLElement>('.tab[data-tab]').forEach((el) => {
      const t = el.dataset.tab as Tab;
      const wants = (t !== tab || !open) && (t === 'diary' || t === 'todo' ? st.todo.some((j) => j.ready) : sectionFor(t).rows.some((r) => r.can && r.buy));
      let d = el.querySelector('.dot');
      if (wants && !d) { d = document.createElement('span'); d.className = 'dot'; el.appendChild(d); }
      else if (!wants && d) d.remove();
      el.classList.toggle('fresh', fresh.has(t));
    });
  }

  tabs.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.tab');
    if (!el) return;
    // Tabs only choose what the drawer shows; the handle above them opens and shuts it.
    openTab(el.dataset.tab as Tab);
  });

  handle.addEventListener('click', () => setOpen(!open));

  function setOpen(to: boolean) {
    open = to;
    drawer.classList.toggle('open', open);
    drawer.classList.toggle('closed', !open);
    handleText.textContent = open ? '▾ Close' : '▴ Open';
    handle.setAttribute('aria-label', open ? 'Close the shop' : 'Open the shop');
    shownKey = '';
    update();
  }

  function openTab(t: Tab) {
    tab = t;
    fresh.delete(t);
    setOpen(true);
  }

  // ------------------------------------------------------------ the round buttons

  function drawAbilities() {
    const st = s();
    const have = ABILITIES.filter((a) => a.need(st));
    const key = have.map((a) => a.id).join(',') + '|' + (st.peace >= 70 ? 0 : st.peace >= 35 ? 1 : 2);
    if (key !== abilitiesKey) {
      // A button that was not there a moment ago hops, so it gets noticed.
      const first = abilitiesKey === '';
      const before = abilitiesKey.split('|')[0].split(',');
      abilitiesKey = key;
      abilities.innerHTML = have.map((a) =>
        `<button class="ab${first || before.includes(a.id) ? '' : ' fresh'}" data-id="${a.id}" title="${esc(mood(a.names, st.peace))}" aria-label="${esc(mood(a.names, st.peace))}"><img alt="" src="${icon(S.ICONS[a.id])}"><i></i></button>`).join('');
    }
    have.forEach((a, i) => {
      const el = abilities.children[i] as HTMLElement;
      const cd = st.cd[a.id] ?? 0;
      const on = (st.buff[a.id] ?? 0) > 0;
      el.classList.toggle('on', on);
      (el.lastElementChild as HTMLElement).style.height = on ? '0' : `${Math.min(100, (cd / a.cd) * 100).toFixed(0)}%`;
    });
  }

  abilities.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.ab');
    if (!el) return;
    const def = ABILITIES.find((a) => a.id === el.dataset.id)!;
    if ((s().cd[def.id] ?? 0) > 0) { toast(`${esc(mood(def.names, s().peace))}: not yet`); hooks.onBuy('no'); return; }
    hooks.onAbility(def.id);
    toast(`<b>${esc(mood(def.names, s().peace))}</b> · ${esc(mood(def.blurb, s().peace))}`);
    update();
  });

  function toast(html: string) {
    toastEl.innerHTML = html;
    toastEl.hidden = false;
    // Restart the little entrance animation.
    toastEl.style.animation = 'none';
    void toastEl.offsetWidth;
    toastEl.style.animation = '';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
    (toastTimer as unknown as { unref?: () => void }).unref?.();
  }

  function chip(id: string, iconUrl: string, value: string, small: string): string {
    return `<div class="chip" data-id="${id}"><img alt="" src="${iconUrl}"><span><b>${value}</b><small>${small}</small></span></div>`;
  }

  function drawPurse() {
    const st = s();
    const items: [string, string, string, string][] = [
      ['blooms', icon(S.FLOWER[st.seed].ripe[0]), fmt(st.blooms), `${fmt(st.rate.blooms)}/s blooms`],
    ];
    if (st.flags.teeth) items.push(['teeth', icon(st.flags.teethNamed ? S.ICONS.tooth ?? ICON.tooth : S.ICONS.pebble ?? ICON.pebble), fmt(st.teeth), `${fmt(st.rate.teeth)}/s ${resName('teeth')}`]);
    if (st.flags.rites) items.push(['whispers', icon(S.ICONS.whisper ?? ICON.whisper), fmt(st.whispers), `${fmt(st.rate.whispers)}/s whispers`]);
    if (st.hatsEver > 0) items.push(['hats', icon(S.ICONS.hat ?? ICON.hat), fmt(st.hats), 'red hats']);
    const key = items.map((i) => i[0] + i[1]).join('|');
    if (key !== purseKey) {
      purseKey = key;
      purse.innerHTML = items.map((i) => chip(...i)).join('');
    }
    items.forEach((it, i) => {
      const el = purse.children[i] as HTMLElement;
      const b = el.querySelector('b')!, sm = el.querySelector('small')!;
      if (b.textContent !== it[2]) b.textContent = it[2];
      if (sm.textContent !== it[3]) sm.textContent = it[3];
    });
  }

  const THEME: Record<string, [string, string, string]> = {
    '--bg': ['#f6edd5', '#d6d0c0', '#110b0f'],
    '--panel': ['#fffaf0', '#e6e1d4', '#1b1217'],
    '--card': ['#ffffff', '#f1ede3', '#24181e'],
    '--ink': ['#3a2a22', '#2c282a', '#dccfc6'],
    '--soft': ['#7a6a58', '#6a655f', '#8f7f7a'],
    '--line': ['#e0d0aa', '#b9b2a2', '#3c262e'],
    '--accent': ['#4f9a48', '#6b7a55', '#9d2431'],
    '--hat': ['#d5392f', '#b8362f', '#e0352b'],
  };

  const mixHex = (a: string, b: string, t: number) => {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = (sh: number) => Math.round(lerp((pa >> sh) & 255, (pb >> sh) & 255, t));
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  };

  let themeAt = -1;

  function drawTheme() {
    const st = s();
    const p = Math.round(st.peace);
    if (p === themeAt) return;
    themeAt = p;
    const root = document.documentElement.style;
    // Cozy down to 55, then greying to 30, then dark.
    for (const k in THEME) {
      const [cozy, grey, dark] = THEME[k];
      const v = p >= 55 ? mixHex(grey, cozy, clamp((p - 55) / 35, 0, 1)) : mixHex(dark, grey, clamp((p - 12) / 43, 0, 1));
      root.setProperty(k, v);
    }
    root.setProperty('--tilt', `${p < 60 ? ((60 - p) / 60) * -1.6 : 0}deg`);
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', p >= 55 ? '#f6edd5' : p >= 25 ? '#d6d0c0' : '#110b0f');
    ticker.classList.toggle('shiver', p < 22);
  }

  function drawTop(now: number) {
    const st = s();
    const p = st.peace;
    const t = p >= 80 ? 'Gnome Garden' : p >= 60 ? 'Gnome Garden.' : p >= 40 ? 'Gnome  Garden' : p >= 22 ? 'GNOME GARDEN' : p >= 8 ? 'THEIR GARDEN' : 'HIS GARDEN';
    if (title.textContent !== t) title.textContent = t;
    const subText = p >= 40 ? 'an increMENTAL game' : p >= 15 ? 'an incre MENTAL game' : 'MENTAL MENTAL MENTAL';
    if (sub.textContent !== subText) sub.textContent = subText;
    peaceFill.style.width = `${clamp(p, 0, 100)}%`;
    peaceFill.style.background = p >= 60 ? 'var(--accent)' : p >= 30 ? '#c79a3a' : 'var(--hat)';
    peaceNum.textContent = `${Math.round(p)}%`;
    const lbl = p < 12 && Math.floor(now / 900) % 4 === 0 ? 'he is waking' : 'Peace of mind';
    if (peaceLabel.textContent !== lbl) peaceLabel.textContent = lbl;
    const note = g.ending ? '' : g.frozen && st.gnomes.gardener > 0 && g.dark < 0.5 ? '' : g.dark >= 0.5 ? `Night ${st.day}` : `Day ${st.day}`;
    if (skyNote.textContent !== note) skyNote.textContent = note;
    document.body.classList.toggle('ending', !!g.ending);
  }

  function drawTicker() {
    if (typing.at < typing.full.length) {
      typing.at = Math.min(typing.full.length, typing.at + 3);
      tickerText.textContent = typing.full.slice(0, typing.at);
    }
  }

  /** Now and then, late on, a word on a button is not the word that was there. */
  function slip(now: number) {
    const st = s();
    if (st.peace > 30 || now < glitchUntil + 2500 || Math.random() > 0.04 + (30 - st.peace) * 0.004) return;
    const names = panel.querySelectorAll<HTMLElement>('.row .name');
    if (!names.length) return;
    const el = names[Math.floor(Math.random() * names.length)];
    el.dataset.glitch = '1';
    el.textContent = WHISPERS[Math.floor(Math.random() * WHISPERS.length)];
    glitchUntil = now + 170 + Math.random() * 200;
  }

  function update() {
    const now = performance.now();
    drawTheme();
    drawTop(now);
    drawPurse();
    drawTabs();
    if (open) drawPanel(now);
    drawAbilities();
    drawTicker();
    slip(now);
  }

  // The typewriter. In node (tests) the timer must not keep the process alive.
  const typist = setInterval(drawTicker, 30) as unknown as { unref?: () => void };
  typist.unref?.();

  function say(textLine: string) {
    typing = { full: textLine, at: 0 };
    tickerText.textContent = '';
  }

  ticker.addEventListener('click', () => openTab('diary'));
  // ------------------------------------------------------------ settings, behind the cog

  function settingsHtml(): string {
    const st = s();
    return `<button class="set" data-set="sound"><span>Sound</span><b>${st.mute ? 'Off' : 'On'}</b></button>`
      + `<p class="hint">Played ${fmtTime(st.stats.played)} · owner number ${st.runs + 1} · ${fmt(st.done)} jobs crossed off</p>`
      + '<button class="set danger" data-set="reset">Burn the diary and start again</button>';
  }

  cog.addEventListener('click', () => modal('Settings', settingsHtml(), 'Done'));

  modalBody.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.set');
    if (!el) return;
    if (el.dataset.set === 'sound') { hooks.onMute(); modalBody.innerHTML = settingsHtml(); }
    else if (el.dataset.set === 'reset') { modalEl.hidden = true; hooks.onReset(); }
  });

  function modal(titleText: string, html: string, ok = 'Carry on', then?: () => void) {
    modalTitle.textContent = titleText;
    modalBody.innerHTML = html;
    modalOk.textContent = ok;
    afterModal = then;
    modalEl.hidden = false;
  }

  modalOk.addEventListener('click', () => {
    modalEl.hidden = true;
    const f = afterModal;
    afterModal = undefined;
    f?.();
  });

  function nudge(t: Tab) {
    if (t !== tab) fresh.add(t);
  }

  handleText.textContent = '▴ Open';
  const last = s().log[s().log.length - 1];
  if (last) { typing = { full: last.text, at: last.text.length }; tickerText.textContent = last.text; }
  update();
  return { update, say, nudge, modal, openTab, toast, isOpen: () => open };
}

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
