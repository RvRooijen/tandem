// What the person set for this browser: kept here, not with the project. A
// phone and a desk are not set the same.

const SOUND = 'tandem-sound';

/** Whether the figure is heard when it talks. Not unless it was turned on. */
export function sound(): boolean {
  try { return localStorage.getItem(SOUND) === '1'; } catch { return false; }
}
export function setSound(on: boolean): void {
  try { if (on) localStorage.setItem(SOUND, '1'); else localStorage.removeItem(SOUND); } catch { /* not kept, then */ }
}

const PANEL = 'tandem-panel';

/** How wide the tools are beside the page, in pixels, when the edge was dragged; otherwise the stylesheet decides. */
export function panelWidth(): number | undefined {
  try { const w = Number(localStorage.getItem(PANEL)); return w > 0 ? w : undefined; } catch { return undefined; }
}
export function setPanelWidth(w: number | undefined): void {
  try { if (w) localStorage.setItem(PANEL, String(Math.round(w))); else localStorage.removeItem(PANEL); } catch { /* not kept, then */ }
}
