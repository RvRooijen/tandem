// The shell's way in. Which games there are is the bundler's to know: every
// games/<id>/page.ts is one.
import './style.css';
import { boot, type PageModule } from './boot.ts';

const pages = import.meta.glob<PageModule>('../games/*/page.ts');

void boot((game) => {
  const load = pages[`../games/${game}/page.ts`];
  if (!load) throw new Error(`there is no games/${game}/page.ts`);
  return load();
});
