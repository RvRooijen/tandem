// A picture of the tab tandem's page is in, as it is shown now. Asked for by
// content.js, on behalf of that page. Chrome only hands one out with <all_urls>
// (or activeTab, which needs a click on the extension every time), so the
// manifest asks for that; content.js itself only runs on localhost.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'tandem-shot' || !sender.tab) return false;
  chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })
    .then((image) => reply({ ok: true, image }), (e) => {
      console.warn('tandem pictures: no picture of the tab', e);
      reply({ ok: false, error: String(e?.message ?? e) });
    });
  return true;
});
