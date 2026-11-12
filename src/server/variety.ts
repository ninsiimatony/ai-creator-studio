// Story variety engine: the creative "dice" are rolled in code, not left to the AI.
// 1. sampleDna(): picks setting, people, twist, ending... with cooldowns, so the same choices never come back too soon.
// 2. Similarity gate: every new topic/title is turned into numbers (free Workers AI embeddings) and compared with past
//    ones; anything too close to an earlier story is thrown away.
// 3. Banned names and tired AI phrases, used by the script prompts.
import type { AiBinding, D1Database } from "./db";

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5"; // 384 numbers per text, free tier friendly
export const TOPIC_SIMILAR = 0.88; // cosine at or above this = "same story"
export const TITLE_SIMILAR = 0.9;
export const OPENING_SIMILAR = 0.88; // first lines of a video vs earlier openings
export const OPENING_WORDS = 0.3; // shared 3-word phrases in the opening
export const PLAN_SIMILAR = 0.9; // list of section headings vs earlier plans

// ---------- tired AI defaults we never want ----------
export const BANNED_NAMES = [
  "Elias", "Mara", "Elara", "Lila", "Clara", "Sarah", "Emily", "Marcus", "Thomas", "Maya", "Mira", "Lily", "Jake",
  "Emma", "Olivia", "Ethan", "Liam", "Sophia", "Ava", "Jack", "Max", "Luna", "Ellie", "Evelyn", "Rachel", "David", "Michael", "John",
];
export const BANNED_PHRASES = [
  "little did they know", "little did she know", "little did he know", "a testament to", "tapestry", "the air was thick with",
  "a chill ran down", "in that moment", "shattered into a million pieces", "unbeknownst", "every fiber of", "just then",
  "suddenly, everything changed", "eyes widened", "a wave of", "sent shivers down", "heart pounding in", "time seemed to stop",
  "lighthouse", "barely above a whisper", "couldn't shake the feeling",
];
export const bannedRules = () =>
  `Never use these names: ${BANNED_NAMES.join(", ")}. Never use these phrases: "${BANNED_PHRASES.join('", "')}". Use the word "suddenly" at most once.`;

// ---------- story DNA pools ----------
type Region = "westafrica" | "eastafrica" | "gulf" | "southasia" | "eastasia" | "latam" | "europe" | "usa" | "uk";
type Setting = { place: string; region: Region };

const SETTINGS_1: Setting[] = [
  { place: "a busy fabric market in Lagos", region: "westafrica" },
  { place: "a family cocoa farm outside Kumasi", region: "westafrica" },
  { place: "a matatu stage and small salon in Nairobi", region: "eastafrica" },
  { place: "a lakeside fishing town near Jinja, Uganda", region: "eastafrica" },
  { place: "a coffee shop in Muscat's old Muttrah souq", region: "gulf" },
  { place: "a high-rise office and a desert camp near Dubai", region: "gulf" },
  { place: "a crowded wedding hall in Hyderabad", region: "southasia" },
  { place: "a tea estate in the hills of Sri Lanka", region: "southasia" },
  { place: "a tech company and a tiny rooftop flat in Seoul", region: "eastasia" },
  { place: "a ramen shop in a snowy Hokkaido town", region: "eastasia" },
  { place: "a samba school in Rio de Janeiro", region: "latam" },
  { place: "a family bakery in Mexico City", region: "latam" },
  { place: "a vineyard in Portugal's Douro valley", region: "europe" },
  { place: "a night train from Warsaw to Kraków", region: "europe" },
  { place: "a Paris newsroom", region: "europe" },
  { place: "a cattle ranch in west Texas", region: "usa" },
  { place: "a small-town diner in Ohio", region: "usa" },
  { place: "a hospital night shift in Chicago", region: "usa" },
  { place: "a seaside caravan park in Cornwall", region: "uk" },
  { place: "a council estate and a barber shop in Manchester", region: "uk" },
  { place: "a cruise ship crossing the Atlantic", region: "europe" },
  { place: "an airport arrivals hall at midnight", region: "usa" },
];

const NAMES: Record<Region, string[]> = {
  westafrica: ["Adaeze", "Tunde", "Chiamaka", "Kwame", "Efua", "Obinna", "Yetunde", "Kofi", "Ngozi", "Sola", "Abena", "Emeka", "Folake", "Yaw"],
  eastafrica: ["Wanjiru", "Otieno", "Nakato", "Mugisha", "Achieng", "Kato", "Amani", "Nalubega", "Baraka", "Zawadi", "Ssemakula", "Atim", "Juma", "Namirembe"],
  gulf: ["Salim", "Mariam", "Khalid", "Noor", "Hamad", "Aisha", "Yousef", "Huda", "Faisal", "Latifa", "Rashid", "Shamsa", "Majid", "Reem"],
  southasia: ["Priya", "Arjun", "Meera", "Rohan", "Anjali", "Vikram", "Kavya", "Sanjay", "Nimmi", "Dilan", "Farah", "Imran", "Lakshmi", "Ravi"],
  eastasia: ["Ji-woo", "Min-jun", "Seo-yeon", "Haruto", "Yui", "Daichi", "Hana", "Sora", "Kenji", "Mei", "Joon-ho", "Aiko", "Ren", "Yuna"],
  latam: ["Valentina", "Mateo", "Camila", "Joaquín", "Luciana", "Diego", "Ximena", "Thiago", "Renata", "Rafael", "Beatriz", "Emilio", "Paloma", "Caio"],
  europe: ["Inês", "Tomasz", "Margaux", "Luca", "Agnieszka", "Henrik", "Sofie", "Matteo", "Zofia", "Julien", "Anouk", "Piotr", "Chiara", "Duarte"],
  usa: ["Darlene", "Wade", "Tamika", "Colton", "Rosalind", "Dwayne", "Kaylee", "Earl", "Brianna", "Hank", "Tyrone", "Joanne", "Russell", "Cheyenne"],
  uk: ["Nell", "Callum", "Bryony", "Declan", "Imogen", "Rhys", "Siobhan", "Alfie", "Tamsin", "Kieran", "Phoebe", "Rory", "Gemma", "Owen"],
};

const AXES_1 = {
  theme: ["a hidden debt", "a secret child", "a broken engagement", "an inheritance fight", "a stolen idea", "a first love returning",
    "a marriage of convenience", "a sacrifice nobody saw", "a lie told to protect someone", "an adoption search", "a jealous sibling",
    "a forbidden friendship across class", "a promise kept for decades", "a misunderstanding that split a family", "a second chance at love",
    "caring for a sick parent", "a wrongful accusation"],
  protagonist: ["night nurse", "retired teacher", "wedding planner", "taxi driver", "young pastor", "immigrant chef", "bank clerk",
    "teenage son", "single father", "grandmother", "struggling musician", "hotel cleaner", "lawyer", "farmer", "flight attendant", "tailor"],
  relationship: ["husband and wife", "two sisters", "father and daughter", "mother and son", "best friends", "boss and employee",
    "in-laws", "step-parent and step-child", "twins", "old classmates", "neighbours", "grandparent and grandchild", "ex-lovers"],
  inciting: ["a letter found in an old coat", "a DNA test result", "a text sent to the wrong person", "a hospital mix-up",
    "an overheard voicemail", "a stranger at a funeral", "a photo on a dating app", "a will read aloud", "a job offer abroad",
    "a car breakdown at night", "a box of old cassette tapes", "a bank statement", "a wedding invitation", "a lost wallet returned"],
  twist: ["the victim was the planner all along", "the wrong person was blamed", "the past event happened differently", "a hidden helper is revealed",
    "no villain: everyone was protecting someone", "the narrator was hiding something", "the rival turns out to be family", "the gift was really an apology",
    "the secret was known by everyone except the hero", "the 'betrayal' was a rescue"],
  ending: ["quiet forgiveness", "justice served fairly", "bittersweet goodbye", "reunion after years", "hopeful new start", "ironic reversal",
    "open ending with a final question", "love wins against the odds", "the hero walks away stronger"],
  pov: ["told in first person as a confession", "told by a narrator in third person", "told through letters and messages", "told by a witness who saw it all",
    "told by the hero years later"],
  era: ["today", "today", "today", "the 1990s", "the 1980s", "the early 2000s"],
};

// Channel 2 (since 2026-11-12): compilations of THREE short, original, first-person scary stories on one everyday
// theme, for teens and adults (not for children). The old goblin-cartoon lists are kept in git history.
const AXES_2 = {
  // "location" is the episode theme: an everyday situation where all 3 stories happen.
  location: ["night shift at work", "camping in the woods", "home alone", "a long road trip", "babysitting", "a late-night gas station",
    "a hospital at night", "a cheap motel", "hiking alone", "moving into a new house", "a college dorm", "a snowed-in winter cabin",
    "a quiet farm far from town", "a new apartment", "a thunderstorm power cut", "a rural back road", "a summer lake house",
    "a delivery driver's route", "a hunting trip", "an empty office after hours"],
  season: ["a freezing winter night", "a foggy autumn evening", "a hot summer night with thunder", "a rainy spring night", "Halloween week",
    "a power cut at dusk", "a full-moon night", "the longest night of the year"],
  fear: ["footsteps upstairs when no one else is home", "a stranger who knows your name", "a knock at 3 a.m.", "a figure standing at the tree line",
    "a voice that copies someone you love", "lights on in a house that should be empty", "a car that follows with its lights off",
    "something tapping on the window", "a phone call from your own number", "fresh footprints in the snow around the tent",
    "a door you locked standing open", "a person who does not blink", "a radio that picks up a calm voice describing you"],
  guest: ["a night-shift security guard", "a young nurse", "a college student", "two friends on a road trip", "a delivery driver", "a park ranger",
    "a babysitter", "a gas station clerk", "a young couple in their first home", "a hunter and his brother", "a truck driver", "a solo hiker"],
  // How the three stories are framed (the old key name is kept so saved cooldowns still work).
  goblinRole: ["each story is told in first person, as if the narrator is reading a letter sent in by a viewer (it is fiction)",
    "each story is told by a different worker or traveller, each a different age",
    "the three stories get scarier one after another, the worst is last",
    "the three stories happen in three different decades",
    "each story ends with one small unexplained detail"],
  twist: ["the person who helped was never there", "someone had been living in the house the whole time", "the call came from inside the building",
    "the stranger was trying to warn them", "the noise was a recording of their own voice", "the cabin had been empty for twenty years",
    "the friend in the car was not who they thought", "the footprints led back to their own door", "the message was dated tomorrow",
    "the person on the camera was standing right behind them"],
  ending: ["no explanation, just one last chilling detail", "they escaped, but something followed them home", "they never went back",
    "a final line that makes the listener check the window", "they found out the truth years later"],
};

// Channel 3: wildlife, oceans, space, planet Earth and the old world (true topics shown with free licensed footage).
const AXES_3 = {
  subject: [
    "whales and dolphins", "sharks", "octopuses and squid", "coral reefs", "the deep ocean floor", "sea turtles", "penguins and the polar south",
    "polar bears and the Arctic", "elephants", "lions and big cats", "wolves", "bears", "primates and apes", "birds of prey", "migrating birds",
    "owls and night hunters", "hummingbirds", "bees and pollinators", "ants and termite cities", "butterflies and moths", "snakes and reptiles",
    "crocodiles and alligators", "frogs and amphibians", "rain forests", "deserts", "mountains and glaciers", "volcanoes", "caves", "rivers and waterfalls",
    "thunderstorms and lightning", "the Northern Lights", "the Moon", "Mars", "the Sun", "Jupiter and Saturn", "comets and asteroids", "black holes and galaxies",
    "astronauts and life on the space station", "stars and the night sky", "tides and the seasons", "trees and forests", "mushrooms and fungi", "flowers and plants that hunt",
    "farm animals and horses", "cats and dogs", "island wildlife", "grasslands and the savanna", "wetlands and swamps", "ancient ruins and lost cities",
    "old-time machines and inventions", "life long ago: farms, towns and trades",
  ],
  angle: ["a surprising fact most people do not know", "how it survives", "how it sleeps, rests or hides", "how it talks or communicates", "a record it holds",
    "how it raises its young", "a myth versus the truth", "a day in its life", "how it has changed over time", "what scientists are still trying to learn",
    "how it finds food", "how it deals with extreme weather", "how humans and it live side by side"],
  hook: ["start with a question", "start with a surprising number you are sure about", "start with a quiet, vivid image", "start with a common belief that is wrong",
    "start with 'imagine'", "start with a sound or a smell", "start in the middle of the action"],
};

const GUEST_NAMES = ["Tobi", "Imani", "Rafi", "Zuri", "Nico", "Asha", "Kai", "Leni", "Omar", "Pita", "Juno", "Dara", "Femi", "Ines", "Bo", "Selim", "Wren", "Ayo", "Kiri", "Tess"];

// Cooldown windows in days (how long before a value may come back).
const COOLDOWN_1: Record<string, number> = { setting: 25, theme: 4, protagonist: 18, relationship: 6, inciting: 14, twist: 8, ending: 3, pov: 2, era: 1 };
const COOLDOWN_2: Record<string, number> = { location: 21, season: 5, fear: 14, guest: 7, goblinRole: 4, twist: 12, ending: 3 };
const COOLDOWN_3: Record<string, number> = { subject: 20, angle: 4, hook: 2 };

export type Dna = Record<string, string>;

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;

async function ensure(db: D1Database) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS story_dna (id INTEGER PRIMARY KEY AUTOINCREMENT, channel INTEGER NOT NULL, created_at TEXT NOT NULL, dna TEXT NOT NULL)",
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS story_vecs (id INTEGER PRIMARY KEY AUTOINCREMENT, channel INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, vec TEXT NOT NULL, created_at TEXT NOT NULL)",
    )
    .run();
}

/** Roll a fresh story DNA for a channel, skipping values used within their cooldown window. */
export async function sampleDna(db: D1Database, channel: number, taken: Dna[] = []): Promise<Dna> {
  await ensure(db);
  const since = new Date(Date.now() - 40 * 86400000).toISOString();
  const rows =
    ((await db.prepare("SELECT created_at, dna FROM story_dna WHERE channel=? AND created_at>=? ORDER BY id DESC LIMIT 300").bind(channel, since).all()) as {
      results?: { created_at: string; dna: string }[];
    }).results ?? [];
  const past = rows.map((r) => {
    try {
      return { at: new Date(r.created_at).getTime(), dna: JSON.parse(r.dna) as Dna };
    } catch {
      return null;
    }
  }).filter(Boolean) as { at: number; dna: Dna }[];
  const now = Date.now();
  const cooldown = channel === 3 ? COOLDOWN_3 : channel === 2 ? COOLDOWN_2 : COOLDOWN_1;
  const blocked = (axis: string): Set<string> => {
    const days = cooldown[axis] ?? 0;
    const s = new Set<string>();
    for (const p of past) if (now - p.at < days * 86400000 && p.dna[axis]) s.add(p.dna[axis]!);
    for (const t of taken) if (t[axis]) s.add(t[axis]!); // not twice in the same batch
    return s;
  };
  const choose = (axis: string, pool: string[]) => {
    const b = blocked(axis);
    const free = pool.filter((v) => !b.has(v));
    return pick(free.length ? free : pool);
  };
  const usedNames = new Set<string>();
  for (const p of past) if (now - p.at < 60 * 86400000) for (const n of (p.dna["names"] ?? "").split(", ")) usedNames.add(n);
  for (const t of taken) for (const n of (t["names"] ?? "").split(", ")) usedNames.add(n);

  if (channel === 3) {
    const dna: Dna = {};
    for (const [axis, pool] of Object.entries(AXES_3)) dna[axis] = choose(axis, pool);
    return dna;
  }
  if (channel === 2) {
    const dna: Dna = {};
    for (const [axis, pool] of Object.entries(AXES_2)) dna[axis] = choose(axis, pool);
    const free = GUEST_NAMES.filter((n) => !usedNames.has(n));
    const pool = free.length >= 2 ? free : GUEST_NAMES;
    const a = pick(pool);
    const b = pick(pool.filter((n) => n !== a));
    dna["names"] = `${a}, ${b}`;
    return dna;
  }
  const setB = blocked("setting");
  const freeSettings = SETTINGS_1.filter((s) => !setB.has(s.place));
  const setting = pick(freeSettings.length ? freeSettings : SETTINGS_1);
  const dna: Dna = { setting: setting.place };
  for (const [axis, pool] of Object.entries(AXES_1)) dna[axis] = choose(axis, pool);
  const regionNames = NAMES[setting.region];
  const free = regionNames.filter((n) => !usedNames.has(n));
  const pool = free.length >= 3 ? free : regionNames;
  const names: string[] = [];
  while (names.length < 3) {
    const n = pick(pool);
    if (!names.includes(n)) names.push(n);
  }
  dna["names"] = names.join(", ");
  return dna;
}

export async function saveDna(db: D1Database, channel: number, dna: Dna) {
  await ensure(db);
  await db.prepare("INSERT INTO story_dna (channel, created_at, dna) VALUES (?, ?, ?)").bind(channel, new Date().toISOString(), JSON.stringify(dna)).run();
}

export function dnaLine(channel: number, d: Dna): string {
  if (channel === 3) return `Subject area: ${d["subject"]}; angle: ${d["angle"]}; how the narration opens: ${d["hook"]}`;
  return channel === 2
    ? `Theme of all 3 stories: ${d["location"]}; time: ${d["season"]}; scariest moment: ${d["fear"]}; main narrators include ${d["guest"]} (names ${d["names"]}); ${d["goblinRole"]}; one story's twist: ${d["twist"]}; ending feel: ${d["ending"]}`
    : `Setting: ${d["setting"]} in ${d["era"]}; main character: a ${d["protagonist"]}; relationship: ${d["relationship"]}; heart of the story: ${d["theme"]}; ` +
        `it starts with ${d["inciting"]}; twist: ${d["twist"]}; ending: ${d["ending"]}; ${d["pov"]}; names to use: ${d["names"]}`;
}

// ---------- similarity gate ----------
export function quantize(v: number[]): string {
  // Unit-normalise, then store as signed bytes (base64): small and quick to compare.
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const b = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) b[i] = Math.max(-127, Math.min(127, Math.round((v[i]! / n) * 127)));
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]! & 0xff);
  return btoa(s);
}
export function dequantize(s: string): Int8Array {
  const bin = atob(s);
  const b = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = (bin.charCodeAt(i) << 24) >> 24;
  return b;
}
function cosine(a: Int8Array, b: Int8Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function embed(ai: AiBinding, texts: string[]): Promise<string[] | null> {
  if (!texts.length) return [];
  try {
    const res = (await ai.run(EMBED_MODEL, { text: texts.map((t) => t.slice(0, 1500)) })) as { data?: number[][] };
    if (!res?.data || res.data.length !== texts.length) return null;
    return res.data.map(quantize);
  } catch (e) {
    console.log("embedding failed:", String(e).slice(0, 120));
    return null;
  }
}

export type Neighbour = { text: string; score: number };

/** Load the most recent stored vectors of one kind for a channel. */
export async function recentVecs(db: D1Database, channel: number, kind: string, limit = 220) {
  await ensure(db);
  const rows =
    ((await db.prepare("SELECT text, vec FROM story_vecs WHERE channel=? AND kind=? ORDER BY id DESC LIMIT ?").bind(channel, kind, limit).all()) as {
      results?: { text: string; vec: string }[];
    }).results ?? [];
  return rows.map((r) => ({ text: r.text, vec: dequantize(r.vec) }));
}

export function nearest(vec: string, pool: { text: string; vec: Int8Array }[]): Neighbour {
  const v = dequantize(vec);
  let best: Neighbour = { text: "", score: 0 };
  for (const p of pool) {
    const s = cosine(v, p.vec);
    if (s > best.score) best = { text: p.text, score: s };
  }
  return best;
}

export async function saveVec(db: D1Database, channel: number, kind: string, text: string, vec: string) {
  await ensure(db);
  await db.prepare("INSERT INTO story_vecs (channel, kind, text, vec, created_at) VALUES (?, ?, ?, ?, ?)").bind(channel, kind, text.slice(0, 300), vec, new Date().toISOString()).run();
}

/** Word-trigram overlap, a cheap second check for titles that reuse the same words. */
export function trigramJaccard(a: string, b: string): number {
  const grams = (s: string) => {
    const w = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const g = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) g.add(w.slice(i, i + 3).join(" "));
    return g;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- picture variety (used by the goblin image prompts) ----------
export const CAMERAS = ["wide establishing shot", "medium shot", "extreme close-up on the eyes", "low angle looking up", "high angle looking down",
  "over-the-shoulder shot", "silhouette against a window", "detail insert shot", "dutch tilt angle", "shot through a doorway"];
export const LIGHTS = ["candlelight", "cold moonlight", "a swinging lantern", "dawn fog", "a lightning flash", "green glow from below", "flickering bulb", "warm firelight"];
