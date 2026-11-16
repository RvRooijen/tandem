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
