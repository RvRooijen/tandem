// Tandem's few lines in a project's page. They are not part of the project:
// tandem adds them on the way (core/through.ts) when it shows the page in its
// frame, so that something on any page can be pointed at: by the agent, by the
// words on it as the person reads them or by a CSS selector; and by the
// person, who drags tandem's button onto it (tandem then asks what is at that
// place, and gets a picture of it along). In a scene three.js draws that is
// the thing in the scene, not the canvas it is drawn on (bridge/scene.js, which
// goes before this). And the agent can use the page as a person would, in the person's
// own browser where they see it happen: read what is on it, tap something,
// fill a field in, go somewhere. A page opened on its own is not touched.
(() => {
  if (window.parent === window || window.__tandemPage) return;
  window.__tandemPage = true;
  const say = (msg) => window.parent.postMessage({ tandem: 1, ...msg }, '*');
  const squeeze = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  const seen = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0;
  };
  /** What an element says: what is written on it, or what it is called when nothing is. */
  const words = (el) => squeeze((el.innerText ?? el.textContent) || el.value || el.getAttribute('aria-label') || el.placeholder || el.alt || el.title);

  /** The element that says this: the one that says nothing more, before one that says it among other things; the innermost of those. */
  function byWords(want) {
    const low = squeeze(want).toLowerCase();
    if (!low) return null;
    let best = null, extra = Infinity;
    for (const el of document.body.querySelectorAll('*')) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
      const has = words(el).toLowerCase();
      if (!has.includes(low) || !seen(el)) continue;
      // (Elements come outermost first, so with as few other words the later one, inside, is taken.)
      if (has.length - low.length <= extra) { best = el; extra = has.length - low.length; }
    }
    return best;
  }

  function bySelector(selector) {
    try {
      const all = [...document.querySelectorAll(selector)];
      return all.find(seen) ?? all[0] ?? null;
    } catch { return null; }
  }

  /** A way to name an element that the code can be searched for: its id, or its tag and classes under what holds it. */
  const esc = (name) => (window.CSS?.escape ? window.CSS.escape(name) : String(name).replace(/[^\w-]/g, '\\$&'));
  function selectorOf(el) {
    const parts = [];
    for (let at = el; at && at.nodeType === 1 && at !== document.body && parts.length < 4; at = at.parentElement) {
      if (at.id) { parts.unshift(`#${esc(at.id)}`); break; }
      const classes = [...at.classList].slice(0, 2).map((c) => `.${esc(c)}`).join('');
      let part = at.tagName.toLowerCase() + classes;
      const same = at.parentElement ? [...at.parentElement.children].filter((x) => x.tagName === at.tagName) : [];
      if (!classes && same.length > 1) part += `:nth-of-type(${same.indexOf(at) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  /** What is at a place on the page: the thing a person would name (a button, a link, a field, a heading, a line of text), not the bit of it under the finger. */
  function at(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement || el === document.body) return null;
    return el.closest('button, a, input, select, textarea, label, summary, [role=button], h1, h2, h3, h4, h5, h6, img, svg, canvas, video, li, p, td, th') ?? el;
  }

  const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  /**
   * What is written around something: what the thing it is in says, when that is a line or two (the card a picture
   * is on, with its name); else what stands just before and after it there. It tells apart what says nothing itself
   * (a canvas, a picture) and one of many that say the same (a Buy button in every row).
   */
  function around(el) {
    const own = words(el);
    for (let at = el; at.parentElement && at !== document.body; at = at.parentElement) {
      const says = words(at.parentElement);
      if (says === own) continue;
      if (says.length <= 160) return says;
      const beside = (step) => {
        for (let s = at[step]; s; s = s[step]) {
          const has = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(s.tagName) || !seen(s) ? '' : words(s);
          if (has) return cut(has, 80);
        }
        return '';
      };
      return [beside('previousElementSibling'), beside('nextElementSibling')].filter(Boolean).join(' … ');
    }
    return '';
  }
  // ---- a picture of what is pointed at, for the agent to look at

  const PICTURE = 1024, SMALL = 768;
  /** What colour is behind something: the first thing under it that has one. */
  function behind(el) {
    for (let at = el; at && at.nodeType === 1; at = at.parentElement) {
      const c = getComputedStyle(at).backgroundColor;
      if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c)) return c;
    }
    return '#ffffff';
  }
  /** A part of something that can be drawn (a canvas, a picture, a video), as a picture no larger than it has to be. */
  function copyOf(from, sx, sy, sw, sh, back, least = 0) {
    if (!(sw >= 1 && sh >= 1)) return null;
    // Something small is drawn larger (`least`: how long its long side is at least), at most four times.
    const scale = Math.min(Math.max(1, Math.min(4, least / Math.max(sw, sh))), PICTURE / Math.max(sw, sh));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(from, sx, sy, sw, sh, 0, 0, out.width, out.height);
    // (A picture from somewhere else may not be read back: then there is none.)
    try { return out.toDataURL('image/jpeg', 0.86); } catch { return null; }
  }
  /** A part of a canvas, given as a place on the page: with some room around it, so it is seen where it is. */
  function ofCanvas(canvas, place) {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    // As much room as the thing is large: what it stands on and the shadow it casts are in the picture too.
    const room = Math.max(48, Math.max(place.w, place.h));
    const x0 = Math.max(r.left, place.x - room), y0 = Math.max(r.top, place.y - room);
    const x1 = Math.min(r.left + r.width, place.x + place.w + room), y1 = Math.min(r.top + r.height, place.y + place.h + room);
    const kx = canvas.width / r.width, ky = canvas.height / r.height;
    try { return copyOf(canvas, (x0 - r.left) * kx, (y0 - r.top) * ky, (x1 - x0) * kx, (y1 - y0) * ky, behind(canvas), SMALL); } catch { return null; }
  }
  /**
   * Anything else on the page, drawn again from what it is made of: a copy of it with every style written out,
   * put in a picture the browser draws. What it cannot draw that way (a font or a picture from elsewhere) is left
   * out or looks plainer; a browser that will not hand such a picture back gives none.
   */
  function ofElement(el) {
    return new Promise((resolve) => {
      const r = el.getBoundingClientRect();
      const w = Math.ceil(r.width), h = Math.ceil(r.height);
      if (w < 1 || h < 1) return resolve(null);
      let left = 200;
      const copy = (from) => {
        if (from.nodeType === 3) return document.createTextNode(from.nodeValue);
        if (from.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|LINK|META)$/.test(from.tagName) || --left < 0) return null;
        let to;
        if (/^(CANVAS|IMG|VIDEO)$/.test(from.tagName)) {
          // What is drawn, as it is now; where that may not be read, an empty place of its size.
          to = document.createElement('img');
          const fr = from.getBoundingClientRect();
          const pw = from.tagName === 'IMG' ? from.naturalWidth : from.tagName === 'VIDEO' ? from.videoWidth : from.width;
          const ph = from.tagName === 'IMG' ? from.naturalHeight : from.tagName === 'VIDEO' ? from.videoHeight : from.height;
          let data = null;
          try { data = copyOf(from, 0, 0, pw, ph, behind(from)); } catch { /* not to be read */ }
          if (data) to.setAttribute('src', data);
          to.setAttribute('width', String(Math.round(fr.width)));
          to.setAttribute('height', String(Math.round(fr.height)));
        } else to = from.cloneNode(false);
        const cs = getComputedStyle(from);
        let css = '';
        for (let i = 0; i < cs.length; i++) { const v = cs.getPropertyValue(cs[i]); if (v) css += `${cs[i]}:${v};`; }
        to.setAttribute('style', css);
        to.removeAttribute('class');
        to.removeAttribute('id');
        if (from.tagName === 'INPUT' || from.tagName === 'TEXTAREA') { to.setAttribute('value', from.value ?? ''); if (from.tagName === 'TEXTAREA') to.textContent = from.value ?? ''; }
        if (!/^(CANVAS|IMG|VIDEO|TEXTAREA)$/.test(from.tagName)) for (const kid of from.childNodes) { const k = copy(kid); if (k) to.append(k); }
        return to;
      };
      let svg;
      try {
        const root = copy(el);
        if (!root) return resolve(null);
        // Where it stood among other things does not matter here: it is alone in its picture.
        root.style.margin = '0';
        root.style.position = 'static';
        root.style.transform = 'none';
        const holder = document.createElement('div');
        holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        holder.setAttribute('style', `width:${w}px;height:${h}px;background:${behind(el)};overflow:hidden;`);
        holder.append(root);
        svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="100%" height="100%">${new XMLSerializer().serializeToString(holder)}</foreignObject></svg>`;
      } catch { return resolve(null); }
      const img = new Image();
      const give = setTimeout(() => resolve(null), 2500);
      img.onload = () => { clearTimeout(give); let out = null; try { out = copyOf(img, 0, 0, w, h, '#ffffff'); } catch { /* not handed back */ } resolve(out); };
      img.onerror = () => { clearTimeout(give); resolve(null); };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }
  /** A picture of something on the page, as it is now; `place` is where it is when it is a thing in a scene. */
  function pictureOf(el, place) {
    return new Promise((resolve) => {
      const scene = window.__tandemScene;
      if (el.tagName === 'CANVAS') {
        const whole = place ?? (() => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })();
        // What three draws is copied right after it is drawn: at any other moment the canvas may hold nothing.
        if (scene?.whenDrawn(el, () => resolve(ofCanvas(el, whole)))) return;
        return resolve(ofCanvas(el, whole));
      }
      if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
        const pw = el.tagName === 'IMG' ? el.naturalWidth : el.videoWidth, ph = el.tagName === 'IMG' ? el.naturalHeight : el.videoHeight;
        let data = null;
        try { data = copyOf(el, 0, 0, pw, ph, behind(el)); } catch { /* not to be read */ }
        if (data) return resolve(data);
      }
      ofElement(el).then(resolve, () => resolve(null));
    });
  }

  const TAPPED = 'button, a[href], [role=button], [role=link], [role=tab], summary, input[type=submit], input[type=button], input[type=checkbox], input[type=radio]';
  const FIELD = 'input:not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select';

  /** What a field is called: its label, or what it says it is for. */
  function fieldName(el) {
    const label = el.labels?.[0] ?? el.closest('label');
    const own = label ? squeeze([...label.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches(FIELD) && !n.querySelector(FIELD))).map((n) => n.textContent).join(' ')) : '';
    return own || squeeze(el.getAttribute('aria-label') || el.placeholder || el.name || el.id);
  }

  /** What is on the page now, as lines a person would read it by: headings, text, and what can be tapped or filled in. */
  function look() {
    const lines = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (lines.length >= 160) { lines.push('… (more on the page than is listed here)'); break; }
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !seen(el)) continue;
      const off = el.disabled || el.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : '';
      if (/^H[1-6]$/.test(el.tagName)) lines.push(`${'#'.repeat(Number(el.tagName[1]))} ${cut(words(el), 160)}`);
      else if (el.matches('input[type=checkbox], input[type=radio]')) lines.push(`[${el.type}: ${el.checked ? 'on' : 'off'}] ${cut(fieldName(el), 80)}${off}`);
      else if (el.matches(TAPPED)) {
        if (el.closest('a[href], button') !== el && el.closest('a[href], button')) continue;
        const href = el.tagName === 'A' ? ` → ${cut(el.getAttribute('href') ?? '', 80)}` : '';
        lines.push(`[${el.tagName === 'A' ? 'link' : 'button'}] ${cut(words(el), 80) || '(no words on it)'}${href}${off}`);
      } else if (el.matches(FIELD)) {
        const has = el.tagName === 'SELECT' ? squeeze(el.selectedOptions?.[0]?.textContent) : el.type === 'password' ? (el.value ? '(hidden)' : '') : cut(squeeze(el.value), 80);
        const choices = el.tagName === 'SELECT' ? `; one of: ${cut([...el.options].map((o) => squeeze(o.textContent)).join(' | '), 200)}` : '';
        lines.push(`[field] ${cut(fieldName(el), 80) || '(no name)'}: ${has ? `"${has}"` : 'empty'}${el.placeholder && !has ? ` (shows "${cut(el.placeholder, 60)}")` : ''}${choices}${off}`);
      } else if (el.tagName === 'IMG') { if (el.alt) lines.push(`[picture] ${cut(squeeze(el.alt), 80)}`); }
      else if (!el.closest(`${TAPPED}, h1, h2, h3, h4, h5, h6, label, select`)) {
        // Text that is this element's own, not what something inside it says.
        const own = squeeze([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
        if (own) lines.push(cut(own, 200));
      } else if (el.tagName === 'LABEL' && !el.querySelector(FIELD) && !el.control) lines.push(cut(words(el), 120));
    }
    return { path: location.pathname + location.search + location.hash, title: document.title, lines };
  }

  /** The thing to tap for these words: the button or link they are on, not the letters. */
  const tappable = (el) => el.closest(TAPPED) ?? el.closest('label, [onclick]') ?? el;
  /** The field these words name: the field itself, the one its label is for, or the one inside what was found. */
  function fieldFor(what) {
    const low = squeeze(what).toLowerCase();
    for (const el of document.querySelectorAll(FIELD)) if (seen(el) && fieldName(el).toLowerCase() === low) return el;
    for (const el of document.querySelectorAll(FIELD)) if (seen(el) && fieldName(el).toLowerCase().includes(low)) return el;
    const el = byWords(what) ?? bySelector(what);
    if (!el) return null;
    if (el.matches(FIELD)) return el;
    return el.closest('label')?.control ?? el.querySelector(FIELD) ?? el.closest('label')?.querySelector(FIELD) ?? null;
  }
  const place = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

  /** Something the agent does on the page, as a person would. */
  function act(m) {
    if (m.do === 'look') return { ok: true, ...look() };
    // What this page keeps in the browser, and where it is: the working copy is started from it, so the person is
    // who they are and where they were. And the other side: taking that over, and going there.
    if (m.do === 'state') {
      const dump = (store) => { const out = {}; try { for (let i = 0; i < store.length; i++) { const k = store.key(i); out[k] = store.getItem(k); } } catch { /* no storage here */ } return out; };
      return { ok: true, local: dump(localStorage), session: dump(sessionStorage), path: location.pathname + location.search + location.hash };
    }
    if (m.do === 'load') {
      const fill = (store, from, keep) => {
        try {
          for (const k of Object.keys(dump0(store))) if (!keep(k)) store.removeItem(k);
          for (const [k, v] of Object.entries(from ?? {})) if (!keep(k)) store.setItem(k, String(v));
        } catch { /* no storage here */ }
      };
      const dump0 = (store) => { const out = {}; for (let i = 0; i < store.length; i++) out[store.key(i)] = 1; return out; };
      // (What tandem itself keeps here, for a page that uses its bridge, is left alone.)
      const own = (k) => k.startsWith('tandem-');
      fill(localStorage, m.local, own);
      fill(sessionStorage, m.session, own);
      const to = typeof m.path === 'string' && /^[/?#]/.test(m.path) && !m.path.startsWith('//') ? m.path : location.pathname;
      setTimeout(() => { if (to.startsWith('#')) { location.hash = to; location.reload(); } else location.replace(to); }, 60);
      return { ok: true, did: 'took over what the project keeps in the browser' };
    }
    if (m.do === 'go') {
      const to = String(m.path ?? '');
      if (!/^[/?#]/.test(to) || to.startsWith('//')) return { ok: false, error: 'a place in this app starts with / (or ? or #)' };
      setTimeout(() => location.assign(to), 60);
      return { ok: true, did: `went to ${to}` };
    }
    if (m.do === 'tap') {
      const found = byWords(m.at) ?? bySelector(m.at);
      if (!found) return { ok: false, error: `there is nothing on the page that says or is "${m.at}"` };
      const el = tappable(found);
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, error: `"${cut(words(el), 60)}" cannot be tapped now: it is disabled` };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      setTimeout(() => el.click(), 350);
      return { ok: true, did: `tapped ${el.tagName.toLowerCase()} "${cut(words(el), 60)}"`, ...place(el) };
    }
    if (m.do === 'type') {
      const el = fieldFor(m.at);
      if (!el) return { ok: false, error: `there is no field on the page called "${m.at}"` };
      if (el.disabled || el.readOnly) return { ok: false, error: `the field "${cut(fieldName(el), 60)}" cannot be filled in now` };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const text = String(m.text ?? '');
      if (el.tagName === 'SELECT') {
        const option = [...el.options].find((o) => squeeze(o.textContent).toLowerCase() === text.toLowerCase() || o.value === text);
        if (!option) return { ok: false, error: `"${cut(fieldName(el), 60)}" has no choice "${text}"; it has: ${[...el.options].map((o) => squeeze(o.textContent)).join(' | ')}` };
        el.value = option.value;
      } else {
        el.focus?.();
        // (Through the element's own way of taking a value, so a page that keeps its fields itself notices.)
        const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (own?.set) own.set.call(el, text); else el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (m.submit) setTimeout(() => {
        if (el.form?.requestSubmit) el.form.requestSubmit();
        else for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true }));
      }, 350);
      return { ok: true, did: `filled in "${cut(fieldName(el), 60)}"${m.submit ? ' and sent it' : ''}`, ...place(el) };
    }
    return { ok: false, error: `the page does not know how to ${m.do}` };
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.tandem !== 1 || ev.source !== window.parent) return;
    if (m.type === 'do') {
      let out;
      try { out = act(m); } catch (e) { out = { ok: false, error: String(e?.message ?? e) }; }
      return say({ type: 'did', id: m.id, ...out });
    }
    if (m.type === 'pick') {
      const el = at(Number(m.x), Number(m.y));
      if (!el) return say({ type: 'picked', id: m.id, missing: true });
      const r = el.getBoundingClientRect();
      const near = around(el);
      // On a canvas three draws on, what is pointed at is the thing in the scene there, when there is one.
      let thing = null;
      if (el.tagName === 'CANVAS') { try { thing = window.__tandemScene?.at(el, Number(m.x), Number(m.y)) ?? null; } catch { /* a scene that cannot be read: the canvas it is */ } }
      const place = thing ? { x: thing.x, y: thing.y, w: thing.w, h: thing.h } : { x: r.left, y: r.top, w: r.width, h: r.height };
      const got = {
        type: 'picked', id: m.id, ...place,
        words: thing ? thing.words : cut(words(el), 120), ...(near && { near }), tag: el.tagName.toLowerCase(), selector: selectorOf(el), path: location.pathname + location.hash,
        ...(thing && { three: thing.three }),
      };
      // Let go on it: a picture of it goes along.
      if (!m.image) return say(got);
      return void pictureOf(el, thing ? place : null).then((image) => say({ ...got, ...(image && { image }) }), () => say(got));
    }
    if (m.type !== 'find') return;
    // A thing in a scene, by the id three gave it: where it is on its canvas now.
    if (typeof m.at === 'string' && m.at.startsWith('three:')) {
      const where = window.__tandemScene?.where(m.at.slice(6));
      if (!where) return say({ type: 'found', id: m.id, missing: true });
      where.canvas.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return void requestAnimationFrame(() => {
        const now = window.__tandemScene.where(m.at.slice(6)) ?? where;
        say({ type: 'found', id: m.id, x: now.x, y: now.y, w: now.w, h: now.h });
      });
    }
    const el = byWords(m.at) ?? bySelector(m.at);
    if (!el) return say({ type: 'found', id: m.id, missing: true });
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    // Where it is once the page has moved to it.
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      say({ type: 'found', id: m.id, x: r.left, y: r.top, w: r.width, h: r.height });
    });
  });

  const hello = () => say({ type: 'page', can: { find: true, act: true } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello); else hello();
})();
