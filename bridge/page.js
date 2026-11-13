// Tandem's few lines in a project's page. They are not part of the project:
// tandem adds them on the way (core/through.ts) when it shows the page in its
// frame, so that something on any page can be pointed at: by the agent, by the
// words on it as the person reads them or by a CSS selector; and by the
// person, who drags tandem's button onto it (tandem then asks what is at that
// place). A page opened on its own is not touched.
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

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.tandem !== 1 || ev.source !== window.parent) return;
    if (m.type === 'pick') {
      const el = at(Number(m.x), Number(m.y));
      if (!el) return say({ type: 'picked', id: m.id, missing: true });
      const r = el.getBoundingClientRect();
      const said = words(el);
      return say({
        type: 'picked', id: m.id, x: r.left, y: r.top, w: r.width, h: r.height,
        words: said.length > 120 ? `${said.slice(0, 119)}…` : said, tag: el.tagName.toLowerCase(), selector: selectorOf(el), path: location.pathname + location.hash,
      });
    }
    if (m.type !== 'find') return;
    const el = byWords(m.at) ?? bySelector(m.at);
    if (!el) return say({ type: 'found', id: m.id, missing: true });
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    // Where it is once the page has moved to it.
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      say({ type: 'found', id: m.id, x: r.left, y: r.top, w: r.width, h: r.height });
    });
  });

  const hello = () => say({ type: 'page', can: { find: true } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello); else hello();
})();
