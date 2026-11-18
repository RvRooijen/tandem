// Tandem's lines in a view (core/views.ts): how a view asks for what it shows. A view is in a sandbox of its own
// and cannot reach the core itself; it asks tandem's page, which runs the command for it, and only the ones a view
// may: what the page says (logs.read), a SQLite file (data.tables, data.query), the project's server
// (page.request, page.read, api.endpoints), the project's own commands (project.commands, project.run) and the views
// (views.list). What is in the working copy is asked when the stage shows the copy: `tandem.copy`.
//
//   const rows = await tandem.run('data.query', { file: 'data/index.db', sql: 'SELECT …' });
//
// An answer of the project's server that comes in a piece at a time (server-sent events, an answer written as it
// is thought) is followed as it comes: each piece is handed to onPiece, and the whole is there when it has ended.
//
//   const { status, text } = await tandem.stream('/api/answer', { method: 'POST', body: { question } }, (piece, all) => …);
//
// window.tandemView is the view as the project's tandem.json says it (name, kind, file, …), with copy.
// The colours of tandem's tools are there as CSS variables (--t-bg, --t-ink, --t-accent, …) for a view to use.
(() => {
  if (window.tandem) return;
  const view = window.tandemView ?? {};
  let asked = 0;
  const waiting = new Map();
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.tandem !== 1 || m.type !== 'ran' || ev.source !== window.parent) return;
    const done = waiting.get(m.id);
    if (!done) return;
    waiting.delete(m.id);
    if (m.ok) done.resolve(m.result); else done.reject(Object.assign(new Error(m.error ?? 'it did not work'), { code: m.code }));
  });
  window.tandem = {
    view,
    copy: !!view.copy,
    /** Run a command for this view; the answer, or an Error with what went wrong. */
    run(name, input = {}) {
      const id = ++asked;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        window.parent.postMessage({ tandem: 1, type: 'run', id, name, input }, '*');
      });
    },
    /**
     * Ask the project's server for something that comes in a piece at a time (page.request with stream, read with
     * page.read); `init` is { method, body, headers, as, signal }, the signal (an AbortController's) to stop it.
     * onPiece(piece, all) for each piece as it comes; the promise ends with { status, type, text } once the answer
     * has, and rejects when it broke off.
     */
    async stream(path, init = {}, onPiece) {
      const { signal, ...rest } = init;
      const head = await window.tandem.run('page.request', { path, ...rest, stream: true });
      let next = 0, text = '';
      for (;;) {
        const stop = !!signal?.aborted;
        const got = await window.tandem.run('page.read', { stream: head.stream, after: next, ...(stop && { stop: true }) });
        next = got.next;
        if (got.text) { text += got.text; onPiece?.(got.text, text); }
        if (got.done) {
          if (got.error && got.error !== 'stopped') throw new Error(got.error);
          return { status: head.status, type: head.type, text };
        }
        await new Promise((r) => setTimeout(r, got.text ? 60 : 150));
      }
    },
  };
  const style = document.createElement('style');
  style.textContent = ':root{--t-well:#101014;--t-bg:#17161c;--t-plane:#1e1d27;--t-raise:#25242e;--t-raise-2:#2f2e3a;--t-line:#34323f;--t-line-2:#45435a;--t-ink:#ecebf2;--t-ink-2:#cfcdda;--t-soft:#9c9aae;--t-accent:#f2b84b;--t-accent-ink:#20170a;--t-good:#7ad08a;--t-bad:#ff7a70;--t-blue:#8ab8ff;--t-violet:#bca6ff;--t-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}';
  (document.head ?? document.documentElement).prepend(style);
})();
