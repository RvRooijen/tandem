// Real pictures of the page. What the bridge draws again from the page's
// styles is close, but not always what is seen; these are cut out of what the
// screen shows. Two ways to have them: tandem's Chrome extension (extension/,
// loaded once), which takes a picture of the tab without asking; or, without
// it, the person shares this tab (when they let the agent use the page, the
// first time they point at something, or from the settings). Where neither can
// be had (a phone, a browser without it, a window or another tab shared instead
// of this one) the bridge draws it, as before. Tandem's own things over the page
// are left out of the picture.

/** How long the long side of a picture of the whole page is at most: the bridge's pictures are as large. */
export const PICTURE = 1024;

let stream: MediaStream | null = null;
/** The person said no (or the browser did): not asked again by itself, only from the settings. */
let saidNo = false;
let video: HTMLVideoElement | null = null;
const told = new Set<() => void>();
const tell = () => { for (const fn of told) fn(); };

/** Whether tandem's extension is in this browser: it marks the page when it is. */
export const extension = () => typeof document !== 'undefined' && document.documentElement.dataset.tandemPictures === '1';
/** Whether a real picture can be had now, without asking the person. */
export const real = () => extension() || sharing();

/** Whether this browser can share a tab at all. */
export const can = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
export const refused = () => saidNo;
export const sharing = () => !!stream && !!video && stream.getVideoTracks().some((t) => t.readyState === 'live');
/** Called when sharing starts or ends (the browser's own button ends it too). */
export function onChange(fn: () => void): () => void { told.add(fn); return () => told.delete(fn); }

/** Ask to share this tab. Called straight from a click: a browser only asks the person on one. */
export async function share(): Promise<boolean> {
  if (sharing()) return true;
  if (!can()) return false;
  let got: MediaStream;
  try {
    got = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch { saidNo = true; return false; }
  const track = got.getVideoTracks()[0];
  const surface = (track?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  if (!track || (surface && surface !== 'browser')) { for (const t of got.getTracks()) t.stop(); return false; }
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = got;
  try { await v.play(); } catch { for (const t of got.getTracks()) t.stop(); return false; }
  stream = got;
  video = v;
  track.addEventListener('ended', () => { if (stream === got) stop(); });
  tell();
  return true;
}

/** Sharing is ended by the person (here, or with the browser's own button): not asked again by itself either. */
export function stop() {
  saidNo = true;
  for (const t of stream?.getTracks() ?? []) t.stop();
  if (video) video.srcObject = null;
  stream = null;
  video = null;
  tell();
}

/** A frame drawn after the screen changed: tab capture only sends one when something changed, so not waited for long. */
function fresh(v: HTMLVideoElement): Promise<void> {
  return new Promise((done) => {
    const give = setTimeout(done, 300);
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback?.bind(v);
    if (!rvfc) return;
    rvfc(() => rvfc(() => { clearTimeout(give); done(); }));
  });
}

let asked = 0;
/** Why the extension gave no picture, the last time it did not: said once, so a fallback is not silent. */
let lastNo = '';
let onFailed: (why: string) => void = () => {};
export function sayFailures(fn: (why: string) => void) { onFailed = fn; }
const failed = (why: string) => { if (why !== lastNo) { lastNo = why; console.warn(`tandem pictures: ${why}`); onFailed(why); } };
/** The whole tab as a picture, from the extension; null when it does not answer. */
function fromExtension(): Promise<HTMLImageElement | null> {
  const id = ++asked;
  return new Promise((resolve) => {
    const done = (img: HTMLImageElement | null) => { clearTimeout(give); window.removeEventListener('message', on); resolve(img); };
    const give = setTimeout(() => { failed('the extension did not answer (reload the page after the extension was loaded or reloaded)'); done(null); }, 3000);
    const on = (ev: MessageEvent) => {
      const m = ev.data as { tandemPictures?: string; id?: number; ok?: boolean; image?: string } | null;
      if (ev.source !== window || m?.tandemPictures !== 'shot' || m.id !== id) return;
      if (!m.ok || typeof m.image !== 'string') { failed(`the extension gave no picture: ${(m as { error?: string }).error ?? 'it did not say why'}`); return done(null); }
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = m.image;
    };
    window.addEventListener('message', on);
    window.postMessage({ tandemPictures: 'ask', id }, location.origin);
  });
}

/** The whole tab as it is now: from the extension, or else from the shared tab. */
async function whole(): Promise<{ from: CanvasImageSource; w: number; h: number } | null> {
  if (extension()) {
    const img = await fromExtension();
    if (img) return { from: img, w: img.naturalWidth, h: img.naturalHeight };
  }
  const v = video;
  if (!sharing() || !v) return null;
  await fresh(v);
  return { from: v, w: v.videoWidth, h: v.videoHeight };
}

/**
 * A picture of a place on this screen (in CSS pixels), `scale` times as large as it is in CSS pixels; null when
 * there is no real picture to be had, or what was had is not this tab as it is now.
 */
export async function shot(rect: { x: number; y: number; w: number; h: number }, scale: number): Promise<string | null> {
  if (!real()) return null;
  document.body.classList.add('t-shot');
  try {
    // (Shown without tandem's things first: two frames, so the screen has been drawn without them.)
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    const got = await whole();
    if (!got) return null;
    const k = got.w / window.innerWidth;
    // (Not this tab, or not as large as it is now: then a place on the screen is not a place in the picture.)
    if (!(k > 0) || Math.abs(got.h / k - window.innerHeight) > 4) { failed(`the picture is ${got.w} by ${got.h}, the page ${window.innerWidth} by ${window.innerHeight}: not this tab as it is now`); return null; }
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const w = Math.min(window.innerWidth, rect.x + rect.w) - x, h = Math.min(window.innerHeight, rect.y + rect.h) - y;
    if (!(w >= 1 && h >= 1)) return null;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(got.from, x * k, y * k, w * k, h * k, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.86);
  } catch {
    return null;
  } finally {
    document.body.classList.remove('t-shot');
  }
}
