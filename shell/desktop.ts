// What tandem's own window (desktop/) gives the page, when it is shown there and not in a browser.
interface Desktop {
  /** The system's folder picker; null when nothing was chosen. */
  pickFolder(title: string): Promise<string | null>;
}

export const desktop = (window as unknown as { tandemDesktop?: Desktop }).tandemDesktop;
