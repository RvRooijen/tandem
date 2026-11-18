// Between tandem's page and the extension. The page says it wants a picture
// with a message to itself; the answer comes back the same way. Only the page
// in the tab itself is answered, not a page in one of its frames.
document.documentElement.dataset.tandemPictures = '1';
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (ev.source !== window || !m || m.tandemPictures !== 'ask') return;
  const answer = (out) => window.postMessage({ tandemPictures: 'shot', id: m.id, ...out }, location.origin);
  try {
    chrome.runtime.sendMessage({ type: 'tandem-shot' }, (got) => {
      if (chrome.runtime.lastError || !got) return answer({ ok: false, error: chrome.runtime.lastError?.message ?? 'no answer' });
      answer(got);
    });
  } catch (e) {
    // (The extension was reloaded while the page stayed: it answers again once the page is loaded anew.)
    answer({ ok: false, error: String(e?.message ?? e) });
  }
});
