// Tandem's own build of a project's drawings, for a project that has none:
//   tandem export <folder> [--runtime=<file>]
// run in the project (or in the agent's working copy of it). Every drawing in
// art/ becomes something the project can load without knowing the drawing
// format, and one <folder>/sprites.json says what there is:
//   a drawing         <name>.png, a sheet with every frame of every animation
//                     and a row per look; <name>.depth.png when it has a depth
//                     map; for a tilesheet, where its tiles and strips are
//   a character       a drawing that others attach to (clothing, gear): also
//                     <name>.character.png and <name>.character.json, which
//                     the runtime (art/runtime/pixeldraw.js) draws with any
//                     outfit; --runtime copies that file into the project
//   an attachment     is in its base's character; a pinned one (a sword, a
//                     helmet) also has a sheet of its upright image, its picture
//   a 3D model        <name>.glb: its parts as meshes with their colours in their
//                     corners, its bones as the file's tree of nodes and its
//                     animations under their names; <folder>/models.json says
//                     which there are
// A project names this as its build (tandem.json: art.build), so it is run
// again when a drawing changes. It is pixeldraw's sprite and game export.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../core/png.ts';
import { describeModel } from './model/describe.ts';
import { isModel } from './model/format.ts';
import { toGlb } from './model/glb.ts';
import { readModel } from './model/run.ts';
import { buildModel } from './model/shapes.ts';
import { attachmentsOf } from './src/attach.js';
import { buildGame } from './src/gamekit.js';
import { parseArt } from './src/parse.js';
import { spriteSheet, type SpriteSheet } from './sprites.ts';

const RUNTIME = fileURLToPath(new URL('./runtime/pixeldraw.js', import.meta.url));

/** What sprites.json says of one drawing. A frame is [x, y, milliseconds]: where it is on the sheet, and how long it shows. */
export interface Exported {
  image: string;
  depth?: string;
  /** The size of one frame. */
  width: number;
  height: number;
  /** looks[look][animation] = the frames. A drawing without recolors has one look, `default`. */
  looks: SpriteSheet['looks'];
  tiles?: SpriteSheet['tiles'];
  strips?: SpriteSheet['strips'];
  /** A drawing others attach to: the manifest the runtime loads (its atlas is next to it), and what attaches. */
  character?: string;
  attachments?: string[];
  /** A pinned attachment: this sheet is its picture; in the game it is worn through its base's character. */
  attachment?: { base: string; slot: string };
}

/** What models.json says of one model: its file, the box it stands in (wide, high, deep, in its own units), how heavy it is, its bones and its animations with their seconds. */
export interface ExportedModel { file: string; size: [number, number, number]; triangles: number; bones: string[]; animations: Record<string, number> }

interface Parsed { base?: string; slot?: string; error?: string; frames?: { pin?: unknown }[] }

/** A folder or file of the project, by a path from its root: never outside it, never among what is not the project's to load. */
function inside(root: string, path: string, what: string): string {
  const at = relative(resolve(root), resolve(root, path));
  if (!at || at.startsWith('..') || resolve(at) === at) throw new Error(`${what} goes in the project, not ${path}`);
  if (['art', 'depth', '.tandem', '.git', 'node_modules'].includes(at.split(sep)[0])) throw new Error(`${at} is not a place for what the project loads: choose a folder of its own (public/sprites)`);
  return at;
}

/** Export the drawings of the project in `root` to `out`, a folder in it. Says what it wrote, and what it left out. */
export function exportArt(root: string, out: string, runtime?: string): { folder: string; drawings: string[]; models: string[]; characters: string[]; skipped: string[]; runtime?: string } {
  const folder = inside(root, out, 'the sprites');
  const dir = join(root, folder);
  const texts = (sub: string) => {
    const at = join(root, sub);
    return Object.fromEntries((existsSync(at) ? readdirSync(at) : []).filter((f) => f.endsWith('.txt')).sort().map((f) => [f.slice(0, -4), readFileSync(join(at, f), 'utf8')]));
  };
  const parsed = (all: Record<string, string>): Record<string, Parsed> => Object.fromEntries(Object.entries(all).map(([n, text]) => {
    try { return [n, parseArt(text) as Parsed]; } catch (e) { return [n, { error: e instanceof Error ? e.message : String(e) }]; }
  }));
  const every = texts('art'), depth = texts('depth');
  // A model is not a sheet of frames: it is built by itself, below.
  const art = Object.fromEntries(Object.entries(every).filter(([, text]) => !isModel(text)));
  const arts = parsed(art), depths = parsed(depth);
  const index: Record<string, Exported> = {};
  const skipped: string[] = [], characters: string[] = [];
  mkdirSync(dir, { recursive: true });
  const png = (rgba: Uint8ClampedArray, w: number, h: number) => encodePng(new Uint32Array(rgba.buffer, rgba.byteOffset, w * h), w, h, 1, true);

  for (const name of Object.keys(art)) {
    const a = arts[name];
    // (A drawing that cannot be read is said, and the rest is still exported.)
    if (a.error) { skipped.push(`${name} (${a.error})`); continue; }
    // An attachment is in its base's character; only a pinned one has a picture of its own.
    const pinned = !!a.base && !!a.frames?.some((f) => f.pin);
    if (a.base && !pinned) continue;
    let sheet: SpriteSheet;
    try { sheet = spriteSheet(name, art[name], depths[name]?.error ? undefined : depth[name], pinned); } catch (e) { skipped.push(`${name} (${e instanceof Error ? e.message : e})`); continue; }
    writeFileSync(join(dir, `${name}.png`), png(sheet.rgba, sheet.sheetW, sheet.sheetH));
    if (sheet.depthRgba) writeFileSync(join(dir, `${name}.depth.png`), png(sheet.depthRgba, sheet.sheetW, sheet.sheetH));
    index[name] = {
      image: `${name}.png`, ...(sheet.depthRgba && { depth: `${name}.depth.png` }), width: sheet.width, height: sheet.height, looks: sheet.looks,
      ...(sheet.tiles && { tiles: sheet.tiles, strips: sheet.strips }),
      ...(a.base && { attachment: { base: a.base, slot: a.slot ?? '' } }),
    };
    // What others attach to is a character too: the base with every item in every look, split by depth, for the runtime.
    const items = a.base ? [] : (attachmentsOf(name, arts) as string[]).filter((n) => arts[n] && !arts[n].error);
    if (items.length) {
      try {
        const game = buildGame(name, { arts, depths }, `${name}.character.png`) as { width: number; height: number; rgba: Uint8ClampedArray; manifest: unknown };
        writeFileSync(join(dir, `${name}.character.png`), png(game.rgba, game.width, game.height));
        writeFileSync(join(dir, `${name}.character.json`), JSON.stringify(game.manifest) + '\n');
        Object.assign(index[name], { character: `${name}.character.json`, attachments: items });
        characters.push(name);
      } catch (e) { skipped.push(`${name} as a character (${e instanceof Error ? e.message : e})`); }
    }
  }

  // A drawing that is gone takes its files with it.
  const file = join(dir, 'sprites.json');
  let before: Record<string, Exported> = {};
  try { before = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Exported>; } catch { /* the first time */ }
  const kept = new Set(Object.values(index).flatMap((e) => [e.image, e.depth, e.character, e.character?.replace(/json$/, 'png')]));
  for (const was of Object.values(before))
    for (const f of [was.image, was.depth, was.character, was.character?.replace(/json$/, 'png')])
      if (f && !kept.has(f) && /^[\w-]+(\.depth|\.character)?\.(png|json)$/.test(f)) rmSync(join(dir, f), { force: true });
  writeFileSync(file, JSON.stringify(index, null, 1) + '\n');

  // The models: a file each. The list is only there when there is, or was, a model.
  const models: Record<string, ExportedModel> = {};
  const list = join(dir, 'models.json');
  let had: Record<string, ExportedModel> = {};
  try { had = JSON.parse(readFileSync(list, 'utf8')) as Record<string, ExportedModel>; } catch { /* there was none */ }
  for (const [name, text] of Object.entries(every)) {
    if (!isModel(text)) continue;
    try {
      writeFileSync(join(dir, `${name}.glb`), toGlb(buildModel(readModel(text).model), name));
      const d = describeModel(name, text);
      models[name] = { file: `${name}.glb`, size: [d.w, d.h, d.d], triangles: d.triangles, bones: d.bones, animations: d.anims };
    } catch (e) {
      // A model that cannot be built keeps the file it was built as before: what a project loads is not taken away by a text that went wrong.
      const kept = had[name] && existsSync(join(dir, had[name].file));
      if (kept) models[name] = had[name];
      skipped.push(`${name} (${e instanceof Error ? e.message : e}${kept ? `; ${had[name].file} is kept as it was built before` : ''})`);
    }
  }
  for (const was of Object.values(had)) if (!Object.values(models).some((m) => m.file === was.file) && /^[\w-]+\.glb$/.test(was.file)) rmSync(join(dir, was.file), { force: true });
  if (Object.keys(models).length || existsSync(list)) writeFileSync(list, JSON.stringify(models, null, 1) + '\n');

  let copied: string | undefined;
  if (runtime) {
    copied = inside(root, runtime, 'the runtime');
    if (!copied.endsWith('.js')) throw new Error(`the runtime is a JavaScript file: name where it goes (src/pixeldraw.js), not ${runtime}`);
    mkdirSync(dirname(join(root, copied)), { recursive: true });
    copyFileSync(RUNTIME, join(root, copied));
  }
  return { folder, drawings: Object.keys(index), models: Object.keys(models), characters, skipped, ...(copied && { runtime: copied }) };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const out = args.find((a) => !a.startsWith('-'));
  if (!out) {
    console.error('usage: tandem export <folder> [--runtime=<file>]\n  in the project: its drawings in art/ become <folder>/<name>.png and <folder>/sprites.json, its 3D models <folder>/<name>.glb and <folder>/models.json;\n  --runtime copies the file that draws a character (a drawing with attachments) to <file>');
    process.exit(1);
  }
  try {
    const did = exportArt(process.cwd(), out, args.find((a) => a.startsWith('--runtime='))?.slice(10));
    for (const s of did.skipped) console.log(`left out: ${s}`);
    if (did.characters.length && !did.runtime) console.log(`${did.characters.join(', ')}: with attachments, so also a character; --runtime=<file> copies what draws one into the project`);
    if (did.runtime) console.log(`the runtime that draws a character is ${did.runtime}`);
    if (did.models.length) console.log(`${did.models.length} ${did.models.length === 1 ? 'model' : 'models'} exported to ${did.folder}, a .glb each, listed in models.json: ${did.models.join(', ')}`);
    console.log(did.drawings.length ? `${did.drawings.length} ${did.drawings.length === 1 ? 'drawing' : 'drawings'} exported to ${did.folder}: ${did.drawings.join(', ')}` : `no drawings to export; ${did.folder}/sprites.json is empty`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
