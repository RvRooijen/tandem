// The page the game draws itself into: the garden, the header over it, the drawer under it.
// The standalone page and the engine's shell both put this in place before the game starts.
export const MARKUP = `
<div id="app">
    <div id="stage">
      <canvas id="garden"></canvas>
      <header id="top">
        <h1 id="title">Gnome Garden</h1>
        <span id="sub">an increMENTAL game</span>
        <span id="sky-note"></span>
        <div id="peace" title="Peace of mind">
          <span id="peace-label">Peace of mind</span>
          <div id="peace-bar"><i id="peace-fill"></i></div>
          <span id="peace-num">100%</span>
        </div>
        <button id="cog" aria-label="Settings">⚙</button>
      </header>
      <div id="toast" hidden></div>
      <div id="abilities"></div>
    </div>

    <section id="drawer" class="closed">
      <button id="handle" aria-label="Open the shop"><i></i><span id="handle-text">Open</span><i></i></button>
      <div id="purse"></div>
      <button id="ticker" aria-label="Open the diary"><span id="ticker-text"></span></button>
      <nav id="tabs"></nav>
      <main id="panel"></main>
    </section>
  </div>

  <div id="modal" hidden>
    <div id="modal-card">
      <h2 id="modal-title"></h2>
      <div id="modal-body"></div>
      <button id="modal-ok">Carry on</button>
    </div>
  </div>
`;
