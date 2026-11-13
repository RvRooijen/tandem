// Everything the game contains, as data: flowers, gnomes, upgrades, rites,
// heirlooms, visitors and the diary. Wordings come in up to three moods,
// [cozy, odd, creepy]; the UI picks one by how much peace of mind is left.
import type { State } from './state.ts';

export type Res = 'blooms' | 'teeth' | 'whispers' | 'hats';

/**
 * The numbers the game is tuned with that are not part of one flower or one upgrade. They are plain data so they
 * can live in records (content/settings/*.json) and be changed by a proposal without touching code.
 */
export const TUNE = {
  day: { dayLen: 30, nightBase: 45, nightPerPorch: 10, sleepSeconds: 6 },
  economy: { charmPerGnome: 0.03, charmPerLevel: 0.004, hatBonus: 0.1, jobBonus: 0.02, jobPaySeconds: 45, rainGrowth: 0.3 },
  dig: { metreSecondsBase: 200, metreSecondsPerMetre: 3 },
};
export type Cost = Partial<Record<Res, number>>;
export type Words = readonly string[];

export const ROLE = { gardener: 0, digger: 1, lantern: 2, choir: 3 } as const;
export type RoleId = keyof typeof ROLE;
export const ROLE_IDS: RoleId[] = ['gardener', 'digger', 'lantern', 'choir'];

// ---------------------------------------------------------------- flowers

export interface FlowerDef {
  id: string;
  name: string;
  value: number;      // blooms per flower before multipliers
  grow: number;       // seconds to ripen before multipliers
  cost: Cost;         // to buy the seeds
  depth?: number;     // the hole must be this deep before the seeds turn up
  blurb: Words;
  diary?: string;     // written in the diary when first planted
}

export const FLOWERS: FlowerDef[] = [
  { id: 'daisy', name: 'Daisies', value: 1, grow: 3.5, cost: {}, blurb: ['Cheerful. Hard to kill.'] },
  { id: 'tulip', name: 'Tulips', value: 6, grow: 4.5, cost: { blooms: 120 }, blurb: ['A splash of colour for the beds.'] },
  { id: 'sunflower', name: 'Sunflowers', value: 36, grow: 5.5, cost: { blooms: 8_000 }, blurb: ['They turn to face the sun.', 'They turn to face the sun. Mostly the sun.'] },
  { id: 'rose', name: 'Roses', value: 220, grow: 6.5, depth: 6, cost: { blooms: 400_000, teeth: 60 }, blurb: ['The pride of any garden. The soil wants a little grit.', 'Mind the thorns. The gnomes don\'t.'] },
  {
    id: 'toadstool', name: 'Toadstools', value: 1_400, grow: 7.5, depth: 12, cost: { blooms: 4e7, teeth: 1_500 },
    blurb: ['Red with white spots. Just like in the storybooks.', 'They came up on their own. Seems a shame to waste them.'],
    diary: 'A ring of toadstools came up overnight, exactly where the gnomes had been standing. I\'ve decided to find that charming.',
  },
  {
    id: 'eyebright', name: 'Eyebright', value: 9_000, grow: 8.5, depth: 20, cost: { blooms: 4e9, teeth: 30_000 },
    blurb: ['An old cottage-garden herb.', 'It follows the sun. It follows you.', 'It watches the house while they work.'],
    diary: 'The eyebright is in flower. I didn\'t know the name was meant so literally. They all turn when I walk past.',
  },
  {
    id: 'fingerwort', name: 'Fingerwort', value: 60_000, grow: 9.5, depth: 30, cost: { blooms: 4e11, teeth: 600_000 },
    blurb: ['Pale and slender. Comes up in fives.', 'Don\'t shake hands with it.', 'It beckons.'],
    diary: 'Planted what the gnomes brought up from the hole. It comes up in fives, pale, with little nails. It waves when there is no wind.',
  },
  {
    id: 'heartbloom', name: 'Heartbloom', value: 400_000, grow: 10.5, depth: 45, cost: { blooms: 5e13, whispers: 20_000 },
    blurb: ['Warm to the touch.', 'Warm to the touch. Keeps time.', 'It beats when he breathes.'],
    diary: 'The heartbloom opened. The petals are warm. If I put my ear to the bed I can hear all of them, not quite together.',
  },
  {
    id: 'gnomecap', name: 'Gnomecaps', value: 3e6, grow: 11.5, depth: 65, cost: { blooms: 5e15, whispers: 500_000 },
    blurb: ['A little red cap, pushing up through the soil.', 'There is something under each cap.', 'This is where they come from.'],
    diary: 'Little red caps are pushing up through the beds. I pulled one. There was a face under it. I put it back. I said sorry.',
  },
];

// ---------------------------------------------------------------- gnomes

/** What something costs as it is bought again and again: [currency, the first price, how much dearer each next one is]. */
export type Price = [Res, number, number];

/** The cost of the (n+1)th of something. A table, when there is one, lists the first price of each level instead. */
export function priceAt(price: readonly Price[], n: number, table?: readonly number[]): Cost {
  const out: Cost = {};
  price.forEach(([res, first, growth], i) => {
    out[res] = table && i === 0 ? table[n] ?? 1e12 : first * Math.pow(growth, n);
  });
  return out;
}

export interface GnomeDef {
  id: RoleId;
  flag: string;
  names: Words;
  blurb: Words;
  price: Price[];
}

export const GNOMES: GnomeDef[] = [
  {
    id: 'gardener', flag: 'gnomes',
    names: ['Garden gnome', 'Garden gnome', 'One of them'],
    blurb: [
      'A cheerful little ornament for the flower beds. Every gnome makes all your flowers worth 3% more.',
      'He helps, when you aren\'t looking. Every gnome makes all your flowers worth 3% more.',
      'They pick. They carry. They are already here.',
    ],
    price: [['blooms', 15, 1.2]],
  },
  {
    id: 'digger', flag: 'dig',
    names: ['Gnome with a shovel', 'Digger', 'One who digs'],
    blurb: [
      'Where did he get the shovel? Brings up pebbles from the hole.',
      'Digs. Brings what he finds to the doorstep.',
      'Down, and down, and down to him.',
    ],
    price: [['blooms', 200, 1.25]],
  },
  {
    id: 'lantern', flag: 'lantern',
    names: ['Lantern gnome', 'Lantern gnome', 'One who beckons'],
    blurb: [
      'Lights the path so the garden can be enjoyed of an evening. Visitors love it.',
      'The light brings people in from the lane. The evenings are longer with him about.',
      'The light brings them in. They do not all go home.',
    ],
    price: [['blooms', 5_000, 1.4], ['teeth', 20, 1.3]],
  },
  {
    id: 'choir', flag: 'choir',
    names: ['Humming gnome', 'Chorister', 'One who calls'],
    blurb: [
      'Stands by the hole of an evening and hums. Rather pretty.',
      'They sing down the hole. Something keeps time.',
      'They are calling him up.',
    ],
    price: [['teeth', 300, 1.27]],
  },
];

// ---------------------------------------------------------------- upgrades

export type Tab = 'garden' | 'todo' | 'gnomes' | 'below' | 'rites' | 'hats' | 'diary';

export interface UpgradeDef {
  id: string;
  tab: 'garden' | 'below' | 'rites';
  names: Words;
  blurb: Words;
  max: number;
  price: Price[];
  /** The first price of each level, for the few that do not grow by a factor. */
  table?: number[];
  show?: (s: State) => boolean;
  /** Levels on offer before there is a hole, and how many metres of hole each further level takes. The garden can only take so much at once. */
  base?: number;
  per?: number;
  /** For a one-off: the hole must be this deep. */
  depth?: number;
  diary?: string;     // written when first bought
  peace?: number;     // buying it costs peace of mind (lowers the ceiling to this)
}


export const UPGRADES: UpgradeDef[] = [
  // --- garden shed: paid in blooms
  {
    id: 'gloves', base: 3, per: 6, tab: 'garden', max: 10, names: ['Gardening gloves'],
    blurb: ['Flowers you pick yourself are worth half as much again.'],
    price: [['blooms', 25, 3]],
  },
  {
    id: 'can', base: 3, per: 6, tab: 'garden', max: 14, names: ['Watering can', 'Watering can', 'What they water with'],
    blurb: ['Flowers grow 15% faster.', 'Flowers grow 15% faster.', 'Flowers grow 15% faster. It isn\'t water.'],
    price: [['blooms', 60, 3]],
  },
  {
    id: 'compost', base: 3, per: 4, tab: 'garden', max: 24, names: ['Compost', 'Bone meal', 'Bone meal'],
    blurb: ['Richer soil. Every flower is worth 40% more.', 'Richer soil. Every flower is worth 40% more. Good for roses.', 'Every flower is worth 40% more. They supply it themselves now.'],
    price: [['blooms', 100, 3.5]],
  },
  {
    id: 'basket', base: 2, per: 10, tab: 'garden', max: 6, names: ['Little baskets'], show: (s) => s.gnomes.gardener >= 2,
    blurb: ['Each gnome carries one more flower per trip.'],
    price: [['blooms', 400, 6]],
  },
  {
    id: 'boots', base: 2, per: 7, tab: 'garden', max: 12, names: ['Little boots', 'Little boots', 'Quiet boots'], show: (s) => s.gnomes.gardener >= 3,
    blurb: ['Gnomes are 12% quicker on their feet.', 'Gnomes are 12% quicker. You hardly hear them.', 'They are 12% quicker. You will not hear them.'],
    price: [['blooms', 700, 3]],
  },
  {
    id: 'hoe', tab: 'garden', max: 1, names: ['Little hoes'], show: (s) => s.stats.weeds >= 8 && s.gnomes.gardener >= 5,
    blurb: ['The gnomes pull any weed they pass.', 'The gnomes pull any weed they pass. They keep them.'],
    price: [['blooms', 2_500, 1]],
  },
  {
    id: 'porch', base: 1, per: 8, tab: 'garden', max: 5, names: ['Leave the porch light off'], show: (s) => !!s.flags.nightWork,
    blurb: ['They seem to like the dark. The nights last longer.', 'They work better in the dark. The nights last longer.'],
    price: [['blooms', 900, 6]],
  },
  {
    id: 'thumb', base: 1, per: 12, tab: 'garden', max: 6, names: ['Green thumb'], show: (s) => s.totalBlooms >= 1_000,
    blurb: ['Each flower you pick yourself also brings in a tenth of a second of the whole garden\'s income.'],
    price: [['blooms', 5_000, 10]],
  },
  {
    id: 'sign', base: 1, per: 10, tab: 'garden', max: 6, names: ['"Visitors welcome" sign', '"Visitors welcome" sign', '"Come in"'], show: (s) => !!s.flags.lantern,
    blurb: ['More visitors, and they tip better.', 'More visitors, and they tip better.', 'More of them come.'],
    price: [['blooms', 30_000, 6]],
  },

  // --- below: paid in pebbles (teeth)
  {
    id: 'shovel', base: 2, per: 3, tab: 'below', max: 30, names: ['Sharper shovels'],
    blurb: ['The hole deepens 40% faster.'],
    price: [['teeth', 6, 1.7]],
  },
  {
    id: 'sieve', base: 2, per: 4, tab: 'below', max: 24, names: ['Sieve', 'Sieve', 'Pliers'],
    blurb: ['Finds 40% more pebbles in every load.', 'Finds 40% more in every load.', 'Finds 40% more. Some are still warm.'],
    price: [['teeth', 12, 1.8]],
  },
  {
    id: 'steps', base: 1, per: 10, tab: 'below', max: 8, names: ['Little steps'], show: (s) => s.depth >= 3,
    blurb: ['Neatly cut into the side of the hole. Diggers are back up 12% sooner.'],
    price: [['teeth', 40, 3]],
  },
  {
    id: 'roots', base: 1, per: 5, tab: 'below', max: 18, names: ['Feed the roots'], show: (s) => !!s.flags.teethNamed,
    blurb: ['Bury a handful under each bed. Every flower is worth 40% more.', 'Bury a handful under each bed. Every flower is worth 40% more.', 'The beds have teeth now. Every flower is worth 40% more.'],
    price: [['teeth', 30, 2.2]],
  },
  {
    id: 'charm', base: 1, per: 9, tab: 'below', max: 10, names: ['Lucky charms', 'Lucky charms', 'Necklaces'], show: (s) => !!s.flags.teethNamed,
    blurb: ['One on a string for every gnome. Each gnome does a little more for the garden.'],
    price: [['teeth', 120, 3]],
  },

  // --- rites: paid in whispers
  {
    id: 'names', depth: 14, tab: 'rites', max: 1, names: ['Learn their names'], peace: 77,
    blurb: ['Listen to the humming until the names come. Gnomes pick, dig and carry twice as fast.'],
    price: [['whispers', 60, 1]],
    diary: 'I know all their names now. I never chose them. Gerald was never called Gerald.',
  },
  {
    id: 'hum', depth: 16, tab: 'rites', max: 1, names: ['Hum along'],
    blurb: ['You know the tune. You have always known the tune. Three times the whispers.'],
    price: [['whispers', 250, 1]],
  },
  {
    id: 'pretend', depth: 35, tab: 'rites', max: 1, names: ['Tell them they needn\'t pretend'], peace: 60,
    blurb: ['They will stop freezing when you look. They will not stop looking back.'],
    price: [['whispers', 1_000, 1]],
    diary: 'I told them they needn\'t pretend on my account. They\'ve stopped. Honestly it\'s a relief for everyone.',
  },
  {
    id: 'chorus', base: 0, per: 8, tab: 'rites', max: 12, names: ['Another verse'],
    blurb: ['The song is longer than you thought. 50% more whispers.'],
    price: [['whispers', 300, 2.5]],
  },
  {
    id: 'evening', base: 0, per: 25, tab: 'rites', max: 3, names: ['A longer evening', 'A longer evening', 'It is always evening'],
    blurb: ['Ask for a little more dark. The nights grow much longer.', 'Ask for a little more dark.', 'There is no need for the sun.'],
    price: [['whispers', 2_000, 1]], table: [2_000, 40_000, 2_500_000],
  },
  {
    id: 'moonbloom', depth: 40, tab: 'rites', max: 1, names: ['Night-blooming'],
    blurb: ['The flowers stop waiting for the sun. They grow twice as fast in the dark.'],
    price: [['whispers', 6_000, 1]],
  },
  {
    id: 'marrow', depth: 45, tab: 'rites', max: 1, names: ['Marrow'],
    blurb: ['There is more in the ground than you thought. Three times the teeth.'],
    price: [['whispers', 12_000, 1]],
  },
  {
    id: 'gate', depth: 50, tab: 'rites', max: 1, names: ['Leave the gate open at night'], show: (s) => !!s.flags.lantern, peace: 44,
    blurb: ['Visitors who come by lantern-light are made welcome. Very welcome.'],
    price: [['whispers', 20_000, 1]],
    diary: 'I\'ve started leaving the gate open at night. It seemed important. Somebody asked me to, I think.',
  },
  {
    id: 'feed', base: 0, per: 18, tab: 'rites', max: 5, names: ['What the flowers eat'],
    blurb: ['You know now. Every flower is worth three times as much.'],
    price: [['whispers', 30_000, 8]],
  },
  {
    id: 'deeper', base: 0, per: 15, tab: 'rites', max: 6, names: ['Deeper'],
    blurb: ['He is helping from below. The hole deepens two and a half times as fast.'],
    price: [['whispers', 8_000, 5]],
  },
];

export const UPGRADE: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

/** What the next level of an upgrade costs at `level`. */
export const upgradePrice = (u: UpgradeDef, level: number): Cost => priceAt(u.price, level, u.table);

/** The last rite. Buying it ends the run. */
export const UNEARTH_COST = 5_000_000;
export const UNEARTH_DEPTH = 100;

// ---------------------------------------------------------------- things to do yourself

export interface AbilityDef {
  id: string;
  names: Words;
  blurb: Words;
  len: number;      // seconds it lasts
  cd: number;       // seconds before it can be used again
  need: (s: State) => boolean;
}

export const ABILITIES: AbilityDef[] = [
  {
    id: 'water', len: 10, cd: 50, need: (s) => (s.up.can ?? 0) >= 1,
    names: ['Water the beds', 'Water the beds', 'Feed the beds'],
    blurb: ['Flowers grow four times as fast for ten seconds.'],
  },
  {
    id: 'nap', len: 1, cd: 75, need: (s) => !!s.flags.stir && !s.flags.awake,
    names: ['Turn in early'],
    blurb: ['Off to bed. It will be morning before you know it.'],
  },
  {
    id: 'bell', len: 12, cd: 80, need: (s) => !!s.flags.moveByDay,
    names: ['Ring the tea bell', 'Ring the bell', 'Call them'],
    blurb: ['Every gnome hurries for twelve seconds, watched or not. Funny how they know.', 'Every gnome hurries for twelve seconds, watched or not.'],
  },
  {
    id: 'away', len: 12, cd: 100, need: (s) => !!s.flags.moveByDay,
    names: ['Look away', 'Shut your eyes', 'Don\'t look'],
    blurb: ['They work three times as fast when they are sure you can\'t see. Tap the garden to peek.'],
  },
  {
    id: 'sing', len: 15, cd: 150, need: (s) => !!s.flags.rites,
    names: ['Join in', 'Join in', 'Sing'],
    blurb: ['Six times the whispers while you keep the tune.'],
  },
];

export interface TaskDef {
  kind: string;
  /** {n} is the goal. */
  text: Words;
  need?: (s: State) => boolean;
  /** How much to ask for, given how many jobs are already done. r() is a random number in 0..1. */
  goal: (s: State, done: number, r: () => number) => number;
}

const step = (base: number, done: number, per: number, cap: number, r: () => number) =>
  Math.round(Math.min(cap, base + done * per) * (0.8 + r() * 0.4));

export const TASKS: TaskDef[] = [
  {
    kind: 'pick', goal: (_s, d, r) => step(12, d, 1.5, 120, r),
    text: ['Pick {n} flowers for the kitchen table', 'Pick {n} flowers. Leave them on the step', 'pick {n}. they are hungry'],
  },
  {
    kind: 'streak', need: (s) => s.plots >= 6, goal: (s, d, r) => Math.min(s.plots, step(5, d, 0.4, 30, r)),
    text: ['Pick {n} flowers in one go, without stopping', 'Pick {n} in one go. They like to watch you hurry', '{n}. quickly. quickly'],
  },
  {
    kind: 'plots', need: (s) => !!s.flags.plots && s.plots < 46, goal: (_s, _d, r) => 1 + Math.floor(r() * 2),
    text: ['Dig {n} new beds', 'Dig {n} new beds', 'more beds. {n} more'],
  },
  {
    kind: 'gnomes', need: (s) => !!s.flags.gnomes, goal: (_s, d, r) => 1 + Math.floor(r() * Math.min(5, 1 + d / 8)),
    text: ['Buy {n} gnomes for the garden', 'Bring {n} more gnomes home', 'let {n} more of us in'],
  },
  {
    kind: 'deliver', need: (s) => !!s.flags.nightWork, goal: (_s, d, r) => step(15, d, 3, 600, r),
    text: ['Find {n} flowers on the doorstep', 'Count {n} flowers onto the doorstep', 'count them. {n}'],
  },
  {
    kind: 'weed', need: (s) => s.plots >= 6, goal: (_s, d, r) => step(3, d, 0.15, 12, r),
    text: ['Pull {n} weeds', 'Pull {n} weeds. They come back quicker now', 'pull {n}. don\'t look at the roots'],
  },
  {
    kind: 'catch', need: (s) => !!s.flags.gnomes, goal: (_s, d, r) => 1 + Math.floor(r() * Math.min(3, 1 + d / 15)),
    text: ['Catch {n} of whatever is flitting about', 'Catch {n} of the things that visit', 'catch {n}. bring them to the hole'],
  },
  {
    kind: 'ability', need: (s) => ABILITIES.some((a) => a.need(s)), goal: (_s, d, r) => 2 + Math.floor(r() * Math.min(4, 1 + d / 12)),
    text: ['Lend a hand {n} times (the round buttons)', 'Lend a hand {n} times', 'help us {n} times'],
  },
  {
    kind: 'quiet', need: (s) => !!s.flags.stir, goal: (_s, d, r) => Math.round(step(40, d, 1.5, 150, r) / 5) * 5,
    text: ['Leave the garden alone for {n} seconds', 'Don\'t touch the garden for {n} seconds. See what happens', 'do not look for {n} seconds'],
  },
  {
    kind: 'greet', need: (s) => s.gnomes.lantern >= 1, goal: (_s, d, r) => 1 + Math.floor(r() * Math.min(3, 1 + d / 20)),
    text: ['Say hello to {n} visitors', 'Greet {n} visitors. Keep them talking', 'welcome {n} of them. keep them here'],
  },
  {
    kind: 'depth', need: (s) => s.gnomes.digger >= 1 && s.depth < 150, goal: (s, _d, r) => (s.depth < 20 ? 1 : 1 + Math.floor(r() * 2)),
    text: ['See the hole {n} m deeper', 'See the hole {n} m deeper', '{n} m closer to him'],
  },
];

export const TASK: Record<string, TaskDef> = Object.fromEntries(TASKS.map((t) => [t.kind, t]));


// ---------------------------------------------------------------- heirlooms (kept across owners)

export interface HeirloomDef { id: string; name: string; blurb: string; cost: number }

export const HEIRLOOMS: HeirloomDef[] = [
  { id: 'gerald', name: 'The previous owner', blurb: 'Start with three gnomes already in the garden. One of them is you.', cost: 1 },
  { id: 'tools', name: 'Tools in the shed', blurb: 'Start with the watering can, compost and gloves at level 3.', cost: 2 },
  { id: 'habits', name: 'Old habits', blurb: 'The gnomes work by day from the very start.', cost: 3 },
  { id: 'mat', name: 'Welcome mat', blurb: 'Visitors are greeted for you.', cost: 4 },
  { id: 'jar', name: 'A jar in the cellar', blurb: 'Start with 200 teeth, and the diggers remember the way: digging is 3 times as fast.', cost: 6 },
  { id: 'dreams', name: 'They remember you', blurb: 'Time away counts in full instead of half, for up to a day.', cost: 8 },
  { id: 'dusk', name: 'Thicker dark', blurb: 'The nights start out twice as long.', cost: 12 },
  { id: 'tune', name: 'The tune', blurb: 'You are born humming it. Three times the whispers, always.', cost: 20 },
];

// ---------------------------------------------------------------- visitors

export interface VisitorDef { id: string; name: string; left: string }

export const VISITORS: VisitorDef[] = [
  { id: 'neighbour', name: 'the neighbour', left: 'The neighbour came round to complain about the humming. He\'s much quieter now. He has a lovely red hat.' },
  { id: 'postman', name: 'the postman', left: 'The postman\'s bicycle is still leaning on the fence. No post today. No post tomorrow.' },
  { id: 'jogger', name: 'a jogger', left: 'A jogger stopped to tie her lace by the gate. Her headphones are still playing in the grass.' },
  { id: 'birdwatcher', name: 'a birdwatcher', left: 'A man with binoculars asked where all the birds had gone. He knows now.' },
  { id: 'salesman', name: 'a salesman', left: 'A salesman came about the windows. He\'s standing in the rose bed. He isn\'t selling anything.' },
  { id: 'inspector', name: 'the inspector', left: 'Someone from the council came about the hole. There\'s a clipboard on the path. The form is all filled in, in very small handwriting.' },
];

// ---------------------------------------------------------------- the diary

export interface Beat {
  id: string;
  when: (s: State) => boolean;
  text: string | ((s: State) => string);
  peace?: number;          // peace of mind can be no higher than this afterwards
  after?: number;          // not before this many minutes with the first owner (later owners: a third of it)
  flag?: string | string[]; // unlocks
}

const total = (s: State) => s.gnomes.gardener + s.gnomes.digger + s.gnomes.lantern + s.gnomes.choir;

/** Story beats, checked in order. Each fires once per owner. */
export const BEATS: Beat[] = [
  {
    id: 'start', when: () => true,
    text: (s) => s.runs === 0
      ? 'Day 1. Moved in at last. The garden is all weeds, but it\'s mine. I\'ve planted daisies.'
      : s.runs === 1
        ? 'Day 1. Moved in at last. The agent says the last owner "just left". Lovely garden, though. Somebody left a gnome. He looks so pleased with himself.'
        : `Day 1. Moved in at last. ${s.runs} owners in a few years, the agent says, and laughed. Lovely garden. Somebody left a few gnomes.`,
  },
  { id: 'firstPick', when: (s) => s.stats.tapped >= 1, text: 'Picked my first daisy. I think I\'m going to like it here.' },
  { id: 'room', when: (s) => s.totalBlooms >= 8, text: 'There\'s room for more beds if I clear the weeds.', flag: 'plots' },
  { id: 'offer', when: (s) => s.totalBlooms >= 18, text: 'The garden centre has gnomes on offer. A bit twee. ...Why not.', flag: 'gnomes' },
  { id: 'list', when: (s) => s.done >= 1, text: 'Made a to-do list and stuck it on the fridge. Crossing things off is half the pleasure of a garden.' },
  { id: 'catch1', when: (s) => s.stats.critters >= 1, text: 'Caught a butterfly in my hands and let it go again. It left gold dust on my fingers.' },
  { id: 'weed1', when: (s) => s.stats.weeds >= 3, text: 'Weeds already. They do love freshly turned earth.' },
  {
    id: 'gerald', when: (s) => s.gnomes.gardener >= 1, flag: 'nightSoon',
    text: (s) => s.runs === 0
      ? 'Bought a gnome. Put him by the daisies. He looks so pleased with himself. I\'ve named him Gerald.'
      : 'Put the gnome by the daisies. He looks so pleased with himself. I\'ve named him Gerald. It just came to me.',
  },
  {
    // For a while they are ornaments and nothing more. Then the mornings start bringing things.
    id: 'three', when: (s) => s.gnomes.gardener >= 3, after: 5, flag: 'stir',
    text: 'Three gnomes now. They do brighten the place up. Slept like a log.',
  },
  {
    id: 'doorstep', when: (s) => s.stats.delivered >= 1, peace: 97, flag: 'nightWork',
    text: 'Funny. There was a little heap of daisies on the doorstep this morning. I must have picked them and forgotten.',
  },
  { id: 'five', when: (s) => s.gnomes.gardener >= 5, after: 10, peace: 95, text: 'Flowers on the step every morning. I\'ve stopped wondering about it. Lucky gnomes.' },
  {
    id: 'moved', when: (s) => s.gnomes.gardener >= 6, after: 16, peace: 93,
    text: 'I keep finding the gnomes in different spots of a morning. The wind, I suppose. They\'re concrete.',
  },
  { id: 'jobs10', when: (s) => s.done >= 10, after: 25, text: 'Ten jobs crossed off. I don\'t remember writing "more gnomes" on the list, but it\'s a good idea.' },
  {
    id: 'shovel', when: (s) => s.gnomes.gardener >= 8 && s.totalBlooms >= 600, after: 13, peace: 92, flag: 'dig',
    text: 'One of them has a shovel. I don\'t remember buying one with a shovel.',
  },
  { id: 'molehill', when: (s) => s.depth >= 1, text: 'There was a little hole at the bottom of the lawn this morning. Moles, probably. Moles with a shovel.' },
  {
    id: 'pebble', when: (s) => s.totalTeeth >= 1, peace: 91, flag: 'teeth',
    text: 'They left a pebble on the doorstep. Small, smooth, white. Sweet of them. I\'ve started a jar.',
  },
  {
    id: 'restless', when: (s) => s.gnomes.gardener >= 10, after: 28, peace: 90, flag: 'restless',
    text: 'Sleeping badly. I keep waking in the small hours, sure I heard something on the lawn.',
  },
  {
    id: 'caught', when: (s) => s.stats.caught >= 1, peace: 89,
    text: 'Woke in the night and looked out. The gnomes were all over the lawn, halfway to the beds. I must have left them like that. I went back to bed.',
  },
  { id: 'depth2', when: (s) => s.depth >= 2, peace: 89, text: 'The hole\'s knee-deep. For me, I mean. They need a ladder.' },
  {
    id: 'notPebbles', when: (s) => s.depth >= 4, peace: 87, flag: 'teethNamed',
    text: 'Tipped the jar out on the kitchen table and looked properly. They aren\'t pebbles.',
  },
  { id: 'depth6', when: (s) => s.depth >= 6, text: 'The hole is deeper than the shovel is long. They\'ve rigged a bucket on a string.' },
  {
    id: 'parcel', when: (s) => total(s) >= 20 && s.depth >= 5, after: 40, peace: 85, flag: 'lantern',
    text: 'A parcel came. No return address. Inside, in straw: a gnome with a lantern. I put him by the path. It felt rude not to.',
  },
  { id: 'visitor', when: (s) => s.stats.visitors >= 1, text: 'The neighbour stopped to admire the beds. Never seen a garden come on so fast, he said. He kept glancing at the gnomes.' },
  {
    id: 'awake', when: (s) => s.depth >= 7, after: 65, peace: 83, flag: 'awake',
    text: 'I\'ve given up on sleep. I sit at the kitchen window with a cup of tea and watch the garden. It is very busy, for a garden.',
  },
  { id: 'depth8', when: (s) => s.depth >= 8, peace: 82, text: 'There are steps in the hole now. Small ones, neatly cut. They go down a long way.' },
  {
    id: 'miscount', when: (s) => total(s) >= 34, after: 85, peace: 81, flag: 'friends',
    text: (s) => `Counted them this morning. ${cap(words(total(s) + 3))}. I've bought ${words(total(s))}.`,
  },
  { id: 'gnomes60', when: (s) => total(s) >= 60, after: 100, text: 'The garden centre rang to ask if I\'d like to open an account.' },
  {
    id: 'weedFinger', when: (s) => s.stats.weeds >= 40 && s.peace < 82, peace: 80,
    text: 'The weeds have changed. They\'re paler. They pull back.',
  },
  {
    id: 'humming', when: (s) => s.depth >= 12, after: 75, peace: 80, flag: 'choir',
    text: 'Some of them stand round the hole at night and hum. It\'s rather pretty. I caught myself humming along at the sink.',
  },
  {
    id: 'words', when: (s) => s.totalWhispers >= 1, peace: 79, flag: 'rites',
    text: 'The humming has words in it, if you don\'t listen too hard.',
  },
  { id: 'depth16', when: (s) => s.depth >= 16, peace: 78, text: 'Lowered a lantern into the hole on a rope. Ran out of rope.' },
  {
    id: 'jobs40', when: (s) => s.done >= 40, after: 90, peace: 77,
    text: 'There\'s a job on the list in handwriting I don\'t know. Small, neat letters. I did it anyway.',
  },
  { id: 'depth20', when: (s) => s.depth >= 20, peace: 74, text: 'It\'s warm at the bottom of the hole. I haven\'t been down. I just know.' },
  { id: 'window', when: (s) => s.depth >= 25, peace: 71, text: 'One was on the kitchen windowsill this morning. On the inside.' },
  {
    id: 'sawOne', when: (s) => s.gnomes.gardener >= 20, after: 120, peace: 70, flag: 'moveByDay',
    text: 'I saw one move. In broad daylight. No. I didn\'t. I had the sun in my eyes.',
  },
  {
    id: 'looked', when: (s) => s.stats.peeks >= 1, peace: 69,
    text: 'I shut my eyes for a count of ten, just to rest them. The beds were picked clean when I opened them.',
  },
  {
    id: 'crow', when: (s) => s.stats.critters >= 12 && s.peace < 66,
    text: 'A crow sat on the fence all afternoon, watching them work. It left something on the step. I\'ve added it to the jar.',
  },
  { id: 'depth28', when: (s) => s.depth >= 28, peace: 68, text: 'Sounds come up out of the hole at night. Not digging. Something like a very slow clock.' },
  {
    id: 'breathing', when: (s) => s.depth >= 32, peace: 64, flag: 'breath',
    text: 'Something down there is breathing. Slowly. The whole lawn rises and falls with it.',
  },
  { id: 'gnomes150', when: (s) => total(s) >= 150, after: 150, text: 'I can\'t see the lawn from the kitchen window any more. Only hats.' },
  { id: 'depth38', when: (s) => s.depth >= 38, peace: 58, text: 'They\'ve stopped bringing the earth up. I don\'t know where they\'re putting it.' },
  {
    id: 'glass', when: (s) => !!s.flags.scared,
    text: 'Opened my eyes and one was at the glass. Right at the glass. It hadn\'t been a moment.',
  },
  { id: 'jobs100', when: (s) => s.done >= 100, peace: 57, text: 'The list writes itself now. I just do what it says. It\'s easier.' },
  { id: 'sleep', when: (s) => s.depth >= 45, peace: 50, text: 'I don\'t sleep now. I stand at the window. They stand on the lawn. We are waiting for the same thing.' },
  { id: 'depth52', when: (s) => s.depth >= 52, peace: 44, text: 'The hole is wider at the bottom than at the top. That isn\'t how holes work.' },
  {
    id: 'gnomes400', when: (s) => total(s) >= 400,
    text: 'They stand shoulder to shoulder now, right up to the back door. They part when I come out. They close behind me.',
  },
  {
    id: 'hat', when: (s) => s.depth >= 60, peace: 37, flag: 'hatTip',
    text: 'They\'ve uncovered the tip of something red. It is a hat. It is the size of the house.',
  },
  {
    id: 'depth68', when: (s) => s.depth >= 68, peace: 30,
    text: 'It isn\'t only a hat. There is a brow under it. They are brushing the earth from it with their hands, so gently.',
  },
  { id: 'depth74', when: (s) => s.depth >= 74, peace: 26, text: 'I took him a cup of tea. I don\'t know why. I left it on the edge. It was empty in the morning.' },
  { id: 'old', when: (s) => s.depth >= 80, peace: 20, text: 'He\'s so old. He was here before the garden. He was here before the ground.' },
  { id: 'depth84', when: (s) => s.depth >= 84, peace: 16, text: 'They have stopped humming. They are all listening instead. So am I.' },
  { id: 'depth88', when: (s) => s.depth >= 88, peace: 12, text: 'One eye is clear of the soil. It\'s shut. Each lash is as long as my arm.' },
  { id: 'depth94', when: (s) => s.depth >= 94, peace: 7, text: 'The eye opened today. Only a little. He knew me.' },
  {
    id: 'smiling', when: (s) => s.depth >= UNEARTH_DEPTH, peace: 3, flag: 'unearth',
    text: 'HE IS SMILING. He looks so pleased with himself.',
  },
];

/** Small talk between beats, by peace of mind. */
export const FLAVOR: { min: number; max: number; lines: string[] }[] = [
  {
    min: 86, max: 101, lines: [
      'Planted out the last of the seedlings.',
      'The cat from next door slept on the warm step all morning.',
      'Found an old trowel in the shed. Still good.',
      'Hung the washing out. The gnomes looked on approvingly, I like to think.',
      'A blackbird has been singing from the chimney.',
      'Made lemonade. Too much sugar. Drank it anyway.',
      'Lovely weather. Had my tea outside.',
      'The bees have found the garden.',
      'A robin sat on Gerald\'s hat for a while.',
      'Weeded the path. Honest work.',
      'The woman at the garden centre knows me by name now.',
      'Smells of cut grass. Perfect.',
    ],
  },
  {
    min: 66, max: 86, lines: [
      "The step was swept this morning. I don't own a broom that small.",
      'A gnome was facing the wall today, like a child in disgrace.',
      'The watering can was full when I came out. And warm.',
      "One of them has a chip in his hat. He didn't yesterday.",
      "I've stopped hanging the washing out. It felt watched.",
      'Counted them twice. Got two different numbers.',
      'The robin doesn\'t come any more.',
      'Tiny footprints in the flower bed. A hedgehog?',
      'I waved to a gnome on my way in. Habit.',
      'They all seem to face the house.',
      'Found my trowel in the hole. I never lent it.',
      'Said goodnight to the gnomes. Felt silly. Felt worse not to.',
      'The garden centre says they don\'t stock gnomes. Never have.',
    ],
  },
  {
    min: 40, max: 66, lines: [
      "The milk's gone off again. Second time this week.",
      "The hedge is full of birds that don't sing.",
      "I've been laying two places at the table. I only noticed today.",
      'Found soil in the bed. In my bed.',
      "The post has stopped coming. I haven't asked why.",
      'They hum the tune my mother used to hum. I never told anyone that tune.',
      'Dreamt of soil.',
      'Counted hats instead of sheep.',
      'My fingernails are full of earth. I haven\'t been gardening.',
      'The cat from number nine won\'t come past the gate.',
      'I keep the curtains shut now. It doesn\'t help; I know where each one is.',
      'There are more hats than there were at lunch.',
      'Woke up standing on the lawn. Barefoot. They had made room for me.',
      'The jar on the table rattles when the humming starts.',
    ],
  },
  {
    min: 16, max: 40, lines: [
      'I measured the hats. Each is exactly as tall as my hand.',
      'The kitchen clock runs backwards after dark.',
      'There is earth under the door every morning, in a neat little line.',
      "I talked to one for an hour today. I don't recall what I said. I remember it agreed.",
      'The mirror in the hall shows the garden now.',
      'My beard is coming in white.',
      'we like the garden',
      'The flowers lean toward the hole.',
      'I can hear them when the tap is running.',
      'Tried to go to the shops. The gate was shut. The gate is never shut.',
      'Their hats are warm.',
      'Don\'t look at the lawn. Don\'t look at the lawn. Don\'t',
      'I tried on a hat. Just to see. It was a little big. It will fit.',
      'They don\'t blink. I\'ve stopped, too. It\'s easier.',
      'Someone has been writing in this diary. It is my handwriting.',
    ],
  },
  {
    min: -1, max: 16, lines: [
      'the hat fits',
      'it is warm in the ground',
      'one more night',
      'we kept your place',
      'look at us',
      'LOOK AT US',
      'soon',
      'he is nearly awake',
      'you look so pleased',
      'we are so pleased',
      'thank you for digging',
      'there is a hat for you',
      'come down and see',
      'do not stop',
      'WE LOVE THE GARDEN',
    ],
  },
];

/** Shown when the gnomes were busy while the player was gone. */
export const AWAY: Words = [
  'Back from the shops. The step was piled high. Busy little things.',
  'I was only gone a while. They\'ve all moved.',
  'you were gone. we kept digging. we always keep digging.',
];

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A number the way a diary would write it. */
export function words(n: number): string {
  if (n < 20) return SMALL[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + SMALL[n % 10] : '');
  return String(n);
}

export const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
