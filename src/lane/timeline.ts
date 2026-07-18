/**
 * rgui lane source — deep time (Big Bang → far future), the widest 1-D zoom.
 *
 * One lane spanning ~13.8 billion years of past and ~10 billion of predicted
 * future — roughly 25 orders of magnitude of time. The world axis is a LOG
 * (symlog) map of "years before present" by default: worldY = ∓log10(1+|yBP|/1s)
 * so the WHOLE sweep — Big Bang (top) → now → far future (bottom) — fits on one
 * screen, each decade of time taking a constant span, with a 1-second linear
 * core so there is no singularity at now. Zoom just adds label density. Pass
 * { logAxis:false } for the linear axis (worldY = −yBP; roam by zooming).
 *
 * Features layered onto the one-axis semantic zoom:
 *   • adaptive time ruler (Gyr → Myr → kyr → year → date → time)
 *   • geologic era columns (eon / era / age)
 *   • per-type TRACKS (swimlanes) with a runtime FILTER — toggle event types
 *   • FUTURE predictions (Andromeda collision, Sun's red-giant end, …)
 *   • PERIODIC astronomical cycles — recurring ticks that appear only while
 *     their period is resolvable at the current zoom (galactic year, precession,
 *     Milankovitch, Halley, Saros, solar cycle, lunar month)
 *   • off-screen indicators — game-style ▲/▼ badges with the nearest notable
 *     event, its distance, and how many are off-screen in that direction
 */
import { withAlpha, type RgTheme } from "../core/theme.js";
import type { LaneEnv, LaneSource } from "./lane.js";
import {
  evTimestampMs,
  foldCenturyProjector,
  foldDayProjector,
  foldDecadeProjector,
  foldMillenniumProjector,
  precisionWindow,
  projectWindow,
  foldHourProjector,
  foldMonthProjector,
  foldRowStartMs,
  foldWeekProjector,
  foldYearProjector,
  FOLD_PERIOD_MS,
} from "./temporal.js";
import { heatRampColor, srgbToOklch } from "./treefold.js";
import { screenToWorldY, worldToScreenY, type LaneView } from "./view.js";

/**
 * "now" — present reference (Unix seconds), captured at module load. A
 * hardcoded epoch made every commit since build week render as "future"
 * (hollow dots below the now-line) in the git view; live capture keeps the
 * boundary honest. Deep-time statics tolerate the drift trivially — their
 * yBP scales dwarf any clock offset.
 */
const PRESENT_EPOCH = Math.floor(Date.now() / 1000);
const PRESENT_YEAR = new Date().getUTCFullYear();
const SPY = 31556952; // seconds per Julian year
const DAY = 1 / 365.25;
const HOUR = DAY / 24;
const MIN = HOUR / 60;
const SEC = MIN / 60;
const BIG_BANG = 13.8e9; // years before present
const FUTURE_HORIZON = 1e10; // years after present the axis extends to

/** years before present for a UTC calendar date */
const ymd = (y: number, m: number, d: number) =>
  (PRESENT_EPOCH - Date.UTC(y, m - 1, d) / 1000) / SPY;

/**
 * exact-date event coords: years-before-present PLUS the precise instant.
 * `tMs` is what admits an event into calendar folds (see temporal.ts —
 * a bare `y` must never invent calendar precision it doesn't have).
 */
const dated = (y: number, m: number, d: number) => ({
  y: ymd(y, m, d),
  tMs: Date.UTC(y, m - 1, d),
  precision: { kind: "calendar", unit: "day" } as const,
});

// Track key. The deep-time dataset uses the well-known set below; injected
// datasets (see TimelineDataset) bring their own keys. "periodic" is the one
// magic value — that track renders cycles instead of events.
type Cat = string;

export interface CatMeta {
  cat: Cat;
  label: string;
  color: string;
}
/** track order (left→right) + display name + color */
const CAT_META: CatMeta[] = [
  { cat: "cosmic", label: "Cosmos", color: "#f3820d" },
  { cat: "bio", label: "Life", color: "#2dd4bf" },
  { cat: "human", label: "Humans", color: "#ffd21c" },
  { cat: "tech", label: "Tech", color: "#60a5fa" },
  { cat: "repo", label: "Software", color: "#b25ce0" },
  { cat: "future", label: "Future", color: "#f472b6" },
  { cat: "periodic", label: "Cycles", color: "#7dd3fc" },
];
const CAT_COLOR = Object.fromEntries(
  CAT_META.map((m) => [m.cat, m.color]),
) as Record<Cat, string>;

interface Ev {
  y: number; // years before present (negative = future)
  label: string;
  imp: number; // 0..1 — higher survives the declutter longer
  cat: Cat;
  detail?: string;
  /**
   * influence scale: the largest visible time-span (world years) at which this
   * event still shows a label. Beyond it → a presence dot only; far beyond →
   * hidden. Lets minor events fade out sooner than major ones as you zoom out,
   * even in the same track. Omitted → derived from importance.
   */
  influence?: number;
  /**
   * ± uncertainty in years. Many deep-time events are only known to a fuzzy
   * date — they render as a point when zoomed out and expand into a soft
   * uncertainty band once that range spans real pixels. Omitted → auto: a
   * small fraction of the age for prehistoric events, 0 (crisp) for dated ones.
   */
  span?: number;
  /**
   * exact instant (Unix ms, UTC) — present ONLY when the event's source is a
   * real calendar date (dated()/ingested timestamps). Admits the event into
   * temporal folds; without it the event stays on the continuous axis only.
   */
  tMs?: number;
  /**
   * source time precision, captured at ingest BEFORE parsing (Date.parse
   * normalizes absent fields and destroys it). calendar → the containing
   * cycle of that unit is the event's window; uncertainty → epistemic ±
   * bounds in years (deep time), which stays on the continuous fuzzy band
   * and never enters calendar folds.
   */
  precision?:
    | { kind: "calendar"; unit: "year" | "month" | "day" | "hour" | "minute" }
    | { kind: "uncertainty"; beforeYears: number; afterYears: number };
  /**
   * conserved magnitude of the event (e.g. a commit's changed lines). Known
   * mass scales the glyph on a small discrete ladder and brightens it on the
   * track's heat ramp — the same vocabulary as the aggregated cells, so a
   * heat cell is literally the merged dot of its events. Absent = neutral
   * glyph and count-weight 1 in cells (never a fabricated average).
   */
  mass?: number;
}

// mass ladder: powers-of-16 rungs (≤15 lines · ≤255 · ≤4095 · beyond) — a
// discrete, zoom-stable size/brightness step per rung, area-ish growth.
// Invalid magnitudes (NaN/negative — mass is a public field) read as unknown.
export const massBucket = (mass: number | undefined): number =>
  mass === undefined || !Number.isFinite(mass) || mass <= 0
    ? 0
    : Math.max(0, Math.min(3, Math.floor(Math.log2(Math.max(1, mass)) / 4)));
const MASS_DOT_R = [3, 3.7, 4.4, 5] as const;
const MASS_RAMP_N = [1, 3, 8, 20] as const; // rung → heat-ramp count input
/** cell weight: unknown (or invalid) mass counts exactly 1 (legacy count) */
export const massWeight = (mass: number | undefined): number =>
  mass === undefined || !Number.isFinite(mass) || mass < 0
    ? 1
    : Math.max(0.5, Math.min(6, Math.log2(1 + mass) / 5));

/**
 * Effective ± uncertainty (years) for an event — its date PRECISION. Every
 * datum is scale-aware: it stays a point until you zoom past its precision,
 * then blurs into an area. Tiers by age (older ⇒ vaguer), overridable per
 * event via `span`:
 *   • prehistoric (≥5 kyr)  → ~3% of age (deep-time is fuzzy)
 *   • deep antiquity (≥1.5 kyr) → ±40 yr (known to a generation)
 *   • historic (≥150 yr)    → ±2 yr  (known to ~the year → blurs at day zoom)
 *   • modern (<150 yr)      → ±½ day (dated → blurs at hour zoom)
 */
function spanOf(e: Ev): number {
  if (e.span !== undefined) return e.span;
  const a = Math.abs(e.y);
  if (a >= 5000) return a * 0.03;
  if (a >= 1500) return 40;
  if (a >= 150) return 2;
  return 0.5 * DAY;
}

/**
 * Influence scale (world years): the largest visible span at which an event
 * keeps its label. Derived from importance so a major event (imp≈1) shows at
 * the whole-universe scale while a minor one only appears once you zoom into
 * its neighbourhood. `imp^4` makes the fade-out steep.
 */
// influence-scale LOD is computed per-instance (units differ: years on a
// linear axis, log-decades on a log axis) — see createTimelineSource.
const INFLUENCE_BASE_LINEAR = 5.5e10; // > full extent (years) → imp≈1 always
const INFLUENCE_BASE_LOG = 45; // > full extent (log-decades) → imp≈1 always

interface Era {
  from: number; // older bound (years BP)
  to: number; // younger bound (years BP)
  label: string;
  depth: number; // 0 eon · 1 era · 2 age
  color: string;
}

interface Cycle {
  label: string;
  period: number; // years
  color: string;
  from?: number; // years BP the cycle is meaningful from (older)
  to?: number; // …to (younger); default 0 (now)
}

// curated milestones across every scale (years before present)
const EVENTS: Ev[] = [
  { y: 13.8e9, label: "Big Bang", imp: 1, cat: "cosmic", detail: "space, time & energy begin", span: 21e6 },
  { y: 13.79e9, label: "First atoms", imp: 0.7, cat: "cosmic", detail: "recombination" },
  { y: 13.6e9, label: "First stars ignite", imp: 0.85, cat: "cosmic" },
  { y: 13.6e9, label: "Milky Way forms", imp: 0.8, cat: "cosmic" },
  { y: 4.6e9, label: "Solar System forms", imp: 0.9, cat: "cosmic" },
  { y: 4.54e9, label: "Earth forms", imp: 0.95, cat: "cosmic" },
  { y: 4.5e9, label: "Moon-forming impact", imp: 0.7, cat: "cosmic" },
  { y: 3.8e9, label: "First life", imp: 0.92, cat: "bio", detail: "abiogenesis in the oceans" },
  { y: 3.4e9, label: "Photosynthesis", imp: 0.75, cat: "bio" },
  { y: 2.4e9, label: "Great Oxidation Event", imp: 0.8, cat: "bio" },
  { y: 2.1e9, label: "Eukaryotic cells", imp: 0.78, cat: "bio" },
  { y: 0.8e9, label: "Multicellular life", imp: 0.82, cat: "bio" },
  { y: 541e6, label: "Cambrian explosion", imp: 0.88, cat: "bio", detail: "animal body plans radiate" },
  { y: 470e6, label: "Plants colonize land", imp: 0.72, cat: "bio" },
  { y: 375e6, label: "Tetrapods walk on land", imp: 0.72, cat: "bio" },
  { y: 252e6, label: "Permian–Triassic extinction", imp: 0.8, cat: "bio", detail: "the Great Dying" },
  { y: 230e6, label: "Dinosaurs appear", imp: 0.85, cat: "bio" },
  { y: 200e6, label: "First mammals", imp: 0.75, cat: "bio" },
  { y: 66e6, label: "K–Pg extinction", imp: 0.9, cat: "bio", detail: "asteroid ends the dinosaurs" },
  { y: 55e6, label: "First primates", imp: 0.72, cat: "bio" },
  { y: 7e6, label: "Hominins split from apes", imp: 0.78, cat: "human" },
  { y: 2.8e6, label: "Genus Homo", imp: 0.78, cat: "human" },
  { y: 1e6, label: "Control of fire", imp: 0.7, cat: "human" },
  { y: 3e5, label: "Homo sapiens", imp: 0.88, cat: "human", detail: "anatomically modern humans" },
  { y: 7e4, label: "Out of Africa", imp: 0.75, cat: "human" },
  { y: 4e4, label: "Cave art", imp: 0.68, cat: "human" },
  { y: 12e3, label: "Agriculture", imp: 0.85, cat: "human", detail: "Neolithic revolution" },
  { y: 5300, label: "Writing invented", imp: 0.85, cat: "human", detail: "cuneiform, Sumer" },
  { y: 4600, label: "Great Pyramid of Giza", imp: 0.7, cat: "human" },
  { y: 2500, label: "Classical Greece", imp: 0.72, cat: "human" },
  { y: 2026, label: "Roman Empire founded", imp: 0.72, cat: "human" },
  { y: 1550, label: "Fall of Rome", imp: 0.68, cat: "human" },
  { y: PRESENT_YEAR - 1440, label: "Printing press", imp: 0.82, cat: "tech", detail: "Gutenberg" },
  { y: PRESENT_YEAR - 1687, label: "Newton's Principia", imp: 0.72, cat: "tech" },
  { y: PRESENT_YEAR - 1760, label: "Industrial Revolution", imp: 0.82, cat: "tech" },
  { y: PRESENT_YEAR - 1876, label: "Telephone", imp: 0.66, cat: "tech" },
  { y: PRESENT_YEAR - 1903, label: "Powered flight", imp: 0.68, cat: "tech" },
  { y: PRESENT_YEAR - 1942, label: "First electronic computer", imp: 0.82, cat: "tech" },
  { y: PRESENT_YEAR - 1947, label: "Transistor", imp: 0.78, cat: "tech" },
  { y: PRESENT_YEAR - 1969, label: "Moon landing · ARPANET", imp: 0.85, cat: "tech" },
  { y: PRESENT_YEAR - 1991, label: "World Wide Web", imp: 0.85, cat: "tech", detail: "Tim Berners-Lee" },
  { y: PRESENT_YEAR - 2007, label: "Smartphone era", imp: 0.72, cat: "tech" },
  { y: PRESENT_YEAR - 2012, label: "Deep-learning boom", imp: 0.74, cat: "tech" },
  { y: PRESENT_YEAR - 2022, label: "LLM assistants", imp: 0.78, cat: "tech" },
];

// dated Linux kernel milestones (finest curated scale)
const LINUX: Ev[] = [
  { ...dated(1991, 8, 25), label: "Linus announces Linux", imp: 0.68, cat: "repo", detail: '"just a hobby"' },
  { ...dated(1991, 9, 17), label: "Linux 0.01", imp: 0.6, cat: "repo" },
  { ...dated(1992, 1, 5), label: "Linux 0.12 — GPL", imp: 0.55, cat: "repo" },
  { ...dated(1994, 3, 14), label: "Linux 1.0", imp: 0.62, cat: "repo" },
  { ...dated(1996, 6, 9), label: "Linux 2.0 — SMP", imp: 0.55, cat: "repo" },
  { ...dated(1999, 1, 26), label: "Linux 2.2", imp: 0.45, cat: "repo" },
  { ...dated(2001, 1, 4), label: "Linux 2.4", imp: 0.48, cat: "repo" },
  { ...dated(2003, 12, 17), label: "Linux 2.6", imp: 0.5, cat: "repo" },
  { ...dated(2005, 4, 7), label: "Git created", imp: 0.66, cat: "repo", detail: "for kernel dev" },
  { ...dated(2011, 7, 21), label: "Linux 3.0", imp: 0.52, cat: "repo" },
  { ...dated(2015, 4, 12), label: "Linux 4.0", imp: 0.5, cat: "repo" },
  { ...dated(2019, 3, 3), label: "Linux 5.0", imp: 0.5, cat: "repo" },
  { ...dated(2022, 10, 2), label: "Linux 6.0", imp: 0.52, cat: "repo" },
  { ...dated(2024, 11, 17), label: "Linux 6.12 LTS", imp: 0.48, cat: "repo" },
];

// tech & culture across world civilizations (yBP = 2026 − CE year; +BCE)
// pandemics & great disasters — the human-scale punctuation marks that make
// recent centuries legible (taku: "I don't see covid yet")
const DISASTERS: Ev[] = [
  { y: PRESENT_YEAR - 541, label: "Plague of Justinian", imp: 0.7, cat: "human", span: 8 },
  { y: PRESENT_YEAR - 1347, label: "Black Death", imp: 0.86, cat: "human", detail: "~⅓ of Europe dies", span: 5 },
  { ...dated(1755, 11, 1), label: "Lisbon earthquake", imp: 0.66, cat: "human" },
  { ...dated(1815, 4, 10), label: "Tambora eruption", imp: 0.7, cat: "human", detail: "Year Without a Summer" },
  { ...dated(1883, 8, 27), label: "Krakatoa eruption", imp: 0.66, cat: "human" },
  { ...dated(1918, 3, 4), label: "Spanish flu pandemic", imp: 0.84, cat: "human", detail: "H1N1 · ~50M dead", span: 2 },
  { ...dated(1981, 6, 5), label: "AIDS first reported", imp: 0.7, cat: "human" },
  { ...dated(1986, 4, 26), label: "Chernobyl disaster", imp: 0.78, cat: "human" },
  { ...dated(2003, 3, 12), label: "SARS outbreak", imp: 0.6, cat: "human" },
  { ...dated(2004, 12, 26), label: "Indian Ocean tsunami", imp: 0.74, cat: "human" },
  { ...dated(2011, 3, 11), label: "Tōhoku earthquake & tsunami", imp: 0.76, cat: "human", detail: "Fukushima meltdown" },
  { ...dated(2014, 3, 23), label: "West African Ebola epidemic", imp: 0.62, cat: "human" },
  { ...dated(2019, 12, 31), label: "COVID-19 pandemic", imp: 0.92, cat: "human", detail: "WHO declaration 2020-03-11", span: 3 },
];

const CIV: Ev[] = [
  // Mesopotamia · Egypt · Indus (Bronze-Age cradles)
  { y: PRESENT_YEAR + 3500, label: "Wheel invented", imp: 0.66, cat: "tech", detail: "Sumer / Mesopotamia", span: 150 },
  { y: PRESENT_YEAR + 3300, label: "Bronze Age begins", imp: 0.6, cat: "human", detail: "Near East", span: 200 },
  { y: PRESENT_YEAR + 3200, label: "Hieroglyphs", imp: 0.58, cat: "human", detail: "Ancient Egypt", span: 150 },
  { y: PRESENT_YEAR + 2600, label: "Indus Valley cities", imp: 0.6, cat: "human", detail: "Harappa", span: 150 },
  { y: PRESENT_YEAR + 2500, label: "Stonehenge", imp: 0.58, cat: "human", detail: "Neolithic Britain", span: 150 },
  { y: PRESENT_YEAR + 1754, label: "Code of Hammurabi", imp: 0.62, cat: "human", detail: "Babylon", span: 20 },
  { y: PRESENT_YEAR + 1600, label: "Babylonian astronomy", imp: 0.58, cat: "tech", detail: "Babylon", span: 100 },
  // East Asia · China
  { y: PRESENT_YEAR + 1200, label: "Chinese script", imp: 0.62, cat: "human", detail: "Shang China (oracle bone)", span: 80 },
  { y: PRESENT_YEAR + 1200, label: "Olmec civilization", imp: 0.56, cat: "human", detail: "Mesoamerica", span: 100 },
  { y: PRESENT_YEAR + 220, label: "Great Wall begun", imp: 0.64, cat: "human", detail: "Qin China", span: 30 },
  { y: PRESENT_YEAR - 105, label: "Paper invented", imp: 0.66, cat: "tech", detail: "Han China (Cai Lun)", span: 15 },
  { y: PRESENT_YEAR - 132, label: "Seismograph", imp: 0.56, cat: "tech", detail: "Han China (Zhang Heng)", span: 10 },
  { y: PRESENT_YEAR - 850, label: "Gunpowder", imp: 0.66, cat: "tech", detail: "Tang China", span: 40 },
  { y: PRESENT_YEAR - 1040, label: "Movable-type printing", imp: 0.66, cat: "tech", detail: "Song China (Bi Sheng)", span: 15 },
  { y: PRESENT_YEAR - 1088, label: "Magnetic compass", imp: 0.6, cat: "tech", detail: "Song China", span: 20 },
  // Classical Mediterranean · Persia · India
  { y: PRESENT_YEAR + 800, label: "Greek alphabet", imp: 0.58, cat: "human", detail: "Archaic Greece", span: 60 },
  { y: PRESENT_YEAR + 550, label: "Achaemenid Empire", imp: 0.6, cat: "human", detail: "Persia (Cyrus)", span: 30 },
  { y: PRESENT_YEAR + 300, label: "Euclid's Elements", imp: 0.64, cat: "tech", detail: "Hellenistic Greece", span: 20 },
  { y: PRESENT_YEAR + 250, label: "Mauryan Empire", imp: 0.56, cat: "human", detail: "India (Ashoka)", span: 30 },
  { y: PRESENT_YEAR + 250, label: "Archimedes", imp: 0.6, cat: "tech", detail: "Syracuse", span: 20 },
  { y: PRESENT_YEAR + 312, label: "Roman aqueducts", imp: 0.58, cat: "tech", detail: "Rome", span: 40 },
  { y: PRESENT_YEAR + 100, label: "Antikythera mechanism", imp: 0.6, cat: "tech", detail: "Greece — analog computer", span: 30 },
  // Post-classical · Islamic Golden Age · Mesoamerica · Japan · Europe
  { y: PRESENT_YEAR - 250, label: "Maya Long Count", imp: 0.58, cat: "human", detail: "Maya", span: 60 },
  { y: PRESENT_YEAR - 628, label: "Concept of zero", imp: 0.68, cat: "tech", detail: "India (Brahmagupta)", span: 30 },
  { y: PRESENT_YEAR - 800, label: "House of Wisdom", imp: 0.62, cat: "human", detail: "Abbasid Baghdad", span: 30 },
  { y: PRESENT_YEAR - 820, label: "Algebra", imp: 0.66, cat: "tech", detail: "al-Khwārizmī", span: 20 },
  { y: PRESENT_YEAR - 1008, label: "The Tale of Genji", imp: 0.6, cat: "human", detail: "Heian Japan — first novel", span: 8 },
  { y: PRESENT_YEAR - 1021, label: "Book of Optics", imp: 0.6, cat: "tech", detail: "Ibn al-Haytham", span: 15 },
  { y: PRESENT_YEAR - 1088, label: "First university", imp: 0.58, cat: "human", detail: "Bologna, Europe", span: 5 },
  { y: PRESENT_YEAR - 1185, label: "Kamakura shogunate", imp: 0.56, cat: "human", detail: "Japan — samurai era", span: 20 },
  { y: PRESENT_YEAR - 1300, label: "Mechanical clock", imp: 0.6, cat: "tech", detail: "Medieval Europe", span: 30 },
  { y: PRESENT_YEAR - 1325, label: "Tenochtitlán founded", imp: 0.6, cat: "human", detail: "Aztec", span: 10 },
  { y: PRESENT_YEAR - 1450, label: "Machu Picchu built", imp: 0.6, cat: "human", detail: "Inca", span: 20 },
  { y: PRESENT_YEAR - 1670, label: "Ukiyo-e prints", imp: 0.54, cat: "human", detail: "Edo Japan", span: 40 },
  { y: PRESENT_YEAR - 1868, label: "Meiji Restoration", imp: 0.58, cat: "human", detail: "Japan modernizes", span: 3 },
];

// programming languages — first appearance (Software track)
const LANGS: Ev[] = [
  { y: PRESENT_YEAR - 1957, label: "Fortran", imp: 0.56, cat: "repo", detail: "first appeared", span: 0.5 },
  { y: PRESENT_YEAR - 1958, label: "Lisp", imp: 0.55, cat: "repo", detail: "McCarthy", span: 0.5 },
  { y: PRESENT_YEAR - 1959, label: "COBOL", imp: 0.5, cat: "repo", span: 0.5 },
  { y: PRESENT_YEAR - 1972, label: "C", imp: 0.6, cat: "repo", detail: "Ritchie, Bell Labs", span: 0.5 },
  { y: PRESENT_YEAR - 1983, label: "C++", imp: 0.55, cat: "repo", detail: "Stroustrup", span: 0.5 },
  { y: PRESENT_YEAR - 1991, label: "Python", imp: 0.58, cat: "repo", detail: "van Rossum", span: 0.5 },
  { y: PRESENT_YEAR - 1995, label: "Java · JavaScript · Ruby · PHP", imp: 0.58, cat: "repo", detail: "the 1995 wave", span: 0.5 },
  { y: PRESENT_YEAR - 2009, label: "Go", imp: 0.52, cat: "repo", detail: "Google", span: 0.5 },
  { y: PRESENT_YEAR - 2010, label: "Rust", imp: 0.54, cat: "repo", detail: "Mozilla", span: 0.5 },
  { y: PRESENT_YEAR - 2012, label: "TypeScript", imp: 0.54, cat: "repo", detail: "Microsoft", span: 0.5 },
  { y: PRESENT_YEAR - 2014, label: "Swift", imp: 0.5, cat: "repo", detail: "Apple", span: 0.5 },
];

// births of historical figures (Humans track)
const BORN: Ev[] = [
  { y: PRESENT_YEAR + 563, label: "Buddha born", imp: 0.6, cat: "human", detail: "Siddhārtha Gautama" },
  { y: PRESENT_YEAR + 551, label: "Confucius born", imp: 0.6, cat: "human" },
  { y: PRESENT_YEAR + 470, label: "Socrates born", imp: 0.56, cat: "human" },
  { y: PRESENT_YEAR + 384, label: "Aristotle born", imp: 0.56, cat: "human" },
  { y: PRESENT_YEAR + 100, label: "Julius Caesar born", imp: 0.54, cat: "human" },
  { y: PRESENT_YEAR + 4, label: "Jesus born", imp: 0.62, cat: "human", detail: "~4 BCE" },
  { y: PRESENT_YEAR - 570, label: "Muhammad born", imp: 0.6, cat: "human" },
  { y: PRESENT_YEAR - 1452, label: "Leonardo da Vinci born", imp: 0.58, cat: "human" },
  { y: PRESENT_YEAR - 1564, label: "Galileo · Shakespeare born", imp: 0.58, cat: "human", detail: "both 1564" },
  { y: PRESENT_YEAR - 1643, label: "Isaac Newton born", imp: 0.6, cat: "human" },
  { y: PRESENT_YEAR - 1756, label: "Mozart born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1809, label: "Darwin · Lincoln born", imp: 0.56, cat: "human", detail: "same day, 1809" },
  { y: PRESENT_YEAR - 1867, label: "Marie Curie born", imp: 0.56, cat: "human" },
  { y: PRESENT_YEAR - 1879, label: "Einstein born", imp: 0.62, cat: "human", span: 0.5 },
  { y: PRESENT_YEAR - 1912, label: "Alan Turing born", imp: 0.58, cat: "human", span: 0.5 },
  // curated notable births across eras (instant — Wikidata's live "people born
  // in a year range" scan is too slow to fetch; hover-cards pull the details)
  { y: PRESENT_YEAR + 750, label: "Homer born", imp: 0.5, cat: "human", detail: "epic poet (legendary)" },
  { y: PRESENT_YEAR + 570, label: "Pythagoras born", imp: 0.5, cat: "human" },
  { y: PRESENT_YEAR + 259, label: "Qin Shi Huang born", imp: 0.52, cat: "human", detail: "first emperor of China" },
  { y: PRESENT_YEAR + 63, label: "Augustus born", imp: 0.52, cat: "human", detail: "first Roman emperor" },
  { y: PRESENT_YEAR - 748, label: "Charlemagne born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1162, label: "Genghis Khan born", imp: 0.56, cat: "human" },
  { y: PRESENT_YEAR - 1254, label: "Marco Polo born", imp: 0.5, cat: "human" },
  { y: PRESENT_YEAR - 1398, label: "Gutenberg born", imp: 0.54, cat: "human", detail: "printing press" },
  { y: PRESENT_YEAR - 1451, label: "Christopher Columbus born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1473, label: "Copernicus born", imp: 0.54, cat: "human" },
  { y: PRESENT_YEAR - 1483, label: "Martin Luther born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1571, label: "Johannes Kepler born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1596, label: "René Descartes born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1685, label: "J. S. Bach born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1706, label: "Benjamin Franklin born", imp: 0.52, cat: "human" },
  { y: PRESENT_YEAR - 1769, label: "Napoleon born", imp: 0.54, cat: "human" },
  { y: PRESENT_YEAR - 1770, label: "Beethoven born", imp: 0.54, cat: "human" },
  { y: PRESENT_YEAR - 1847, label: "Thomas Edison born", imp: 0.52, cat: "human", span: 0.5 },
  { y: PRESENT_YEAR - 1856, label: "Nikola Tesla born", imp: 0.56, cat: "human", span: 0.5 },
  { y: PRESENT_YEAR - 1869, label: "Mahatma Gandhi born", imp: 0.56, cat: "human", span: 0.5 },
  { y: PRESENT_YEAR - 1918, label: "Nelson Mandela born", imp: 0.54, cat: "human", span: 0.5 },
];

// predicted future events (negative years BP = ahead of now)
const FUTURE: Ev[] = [
  { y: PRESENT_YEAR - 2038, label: "Year 2038 problem", imp: 0.5, cat: "future", detail: "32-bit Unix time overflows" },
  { y: PRESENT_YEAR - 2061, label: "Halley's Comet returns", imp: 0.55, cat: "future" },
  { y: -10e3, label: "End of the interglacial", imp: 0.5, cat: "future" },
  { y: -1e5, label: "Betelgeuse supernova", imp: 0.62, cat: "future", detail: "within ~100 kyr", span: 1e5 },
  { y: -250e6, label: "Pangaea Ultima", imp: 0.66, cat: "future", detail: "next supercontinent" },
  { y: -600e6, label: "End of complex plants", imp: 0.62, cat: "future", detail: "Sun too bright for C3" },
  { y: -1.1e9, label: "Oceans evaporate", imp: 0.72, cat: "future", detail: "Earth's surface sterilized" },
  { y: -4.5e9, label: "Andromeda collision", imp: 0.85, cat: "future", detail: "Milky Way + Andromeda merge" },
  { y: -5e9, label: "Sun becomes a red giant", imp: 0.9, cat: "future", detail: "engulfs the inner planets" },
  { y: -8e9, label: "Sun → white dwarf", imp: 0.8, cat: "future" },
  { y: -FUTURE_HORIZON, label: "Star formation fades", imp: 0.7, cat: "future", detail: "the long cosmic evening" },
];

const CYCLES: Cycle[] = [
  { label: "Galactic year", period: 225e6, color: "#f3820d", from: 13.8e9 },
  { label: "Milankovitch", period: 1e5, color: "#2dd4bf", from: 3e6 },
  { label: "Axial precession", period: 25772, color: "#93c5fd", from: 5e5 },
  { label: "Halley's Comet", period: 75.3, color: "#a3e635" },
  { label: "Metonic cycle", period: 19, color: "#c4b5fd" },
  { label: "Saros (eclipses)", period: 18.03, color: "#7dd3fc" },
  { label: "Solar cycle", period: 11, color: "#fbbf24" },
  { label: "Olympiad / elections", period: 4, color: "#fca5a5" },
  { label: "Islamic (Hijri) year", period: 0.970224, color: "#86efac" },
  { label: "Lunar month", period: 29.53 * DAY, color: "#e5e7eb" },
];

const ERAS: Era[] = [
  { from: 13.8e9, to: 4.6e9, label: "Cosmic dawn", depth: 0, color: "#3b2f6b" },
  { from: 4.54e9, to: 4.0e9, label: "Hadean", depth: 1, color: "#7a3b2e" },
  { from: 4.0e9, to: 2.5e9, label: "Archean", depth: 1, color: "#7a5a2e" },
  { from: 2.5e9, to: 541e6, label: "Proterozoic", depth: 1, color: "#2e6b5a" },
  { from: 541e6, to: 251.9e6, label: "Paleozoic", depth: 1, color: "#2e6b7a" },
  { from: 251.9e6, to: 66e6, label: "Mesozoic", depth: 1, color: "#4a7a2e" },
  { from: 66e6, to: 0, label: "Cenozoic", depth: 1, color: "#7a6a2e" },
  { from: 3.4e6, to: 5300, label: "Stone Age", depth: 2, color: "#6b5a3b" },
  { from: 5300, to: 1550, label: "Antiquity", depth: 2, color: "#8a6a2e" },
  { from: 1550, to: PRESENT_YEAR - 1500, label: "Middle Ages", depth: 2, color: "#6b3b5a" },
  { from: PRESENT_YEAR - 1500, to: PRESENT_YEAR - 1945, label: "Modern era", depth: 2, color: "#3b5a8a" },
  { from: PRESENT_YEAR - 1945, to: 0, label: "Information Age", depth: 2, color: "#3b6b8a" },
];

// adaptive time-ruler steps (years), coarse → fine
const STEPS = [
  5e9, 2e9, 1e9, 5e8, 2e8, 1e8, 5e7, 2e7, 1e7, 5e6, 2e6, 1e6, 5e5, 2e5, 1e5,
  5e4, 2e4, 1e4, 5e3, 2e3, 1e3, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 1 / 12,
  1 / 52, DAY, 6 * HOUR, HOUR, 10 * MIN, MIN, 10 * SEC, SEC,
];

// round-time anchors for the LOG ruler — one clean tick per decade of time
const NICE_TIMES = [
  SEC, 10 * SEC, MIN, 10 * MIN, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY,
  1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10,
];

const pad2 = (n: number) => String(n).padStart(2, "0");

function fmtLabel(yBP: number, step: number): string {
  const fut = yBP < 0; // future → "+N yr", past → "N ya"
  const a = Math.abs(yBP);
  if (step >= 1e3) {
    let mag: string;
    if (a >= 1e9) mag = `${(a / 1e9).toFixed(a / 1e9 < 10 ? 2 : 1)} G`;
    else if (a >= 1e6) mag = `${Math.round(a / 1e6)} M`;
    else mag = `${step >= 1e6 ? Math.round(a / 1e3) : (a / 1e3).toFixed(1)} k`;
    return fut ? `+${mag}yr` : `${mag}ya`;
  }
  if (step >= 1) {
    const year = Math.round(PRESENT_YEAR - yBP);
    return year > 0 ? `${year} CE` : `${1 - year} BCE`;
  }
  const d = new Date((PRESENT_EPOCH - yBP * SPY) * 1000);
  if (step < HOUR)
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (step < DAY)
    return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** a coarse duration for distances/off-screen indicators */
function fmtDur(y: number): string {
  y = Math.abs(y);
  if (y >= 1e9) return `${(y / 1e9).toFixed(y / 1e9 < 10 ? 1 : 0)} Gyr`;
  if (y >= 1e6) return `${Math.round(y / 1e6)} Myr`;
  if (y >= 1e3) return `${Math.round(y / 1e3)} kyr`;
  if (y >= 1) return `${Math.round(y)} yr`;
  if (y >= DAY) return `${Math.round(y / DAY)} d`;
  if (y >= HOUR) return `${Math.round(y / HOUR)} h`;
  if (y >= MIN) return `${Math.round(y / MIN)} min`;
  return `${Math.max(1, Math.round(y / SEC))} s`;
}

/** truncate text to fit maxW px (… when clipped) */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 4) return "";
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo) + "…";
}

const RULER_W = 74;
const ERA_X = RULER_W;
const ERA_COLW = 38;
const ERA_W = ERA_COLW * 3;
const TRACK_X0 = ERA_X + ERA_W + 8;
const HEADER_H = 17; // sticky track-header strip
const LABEL_GAP = 15; // min px between event labels within a track

export interface SearchHit {
  label: string;
  detail?: string;
  cat: Cat;
  color: string;
  /** viewport-center world-y to focus */
  center: number;
  /** world-span to fit (→ zoom = viewportHeight / scale) */
  scale: number;
  /** folded mode: the hit's phase within its row (for the pulse highlight) */
  phase?: number;
}

export type TimelineFold =
  | "none"
  | "year"
  | "month"
  | "week"
  | "day"
  | "hour"
  | "decade"
  | "century"
  | "millennium";

export interface TimelineSource extends LaneSource {
  readonly categories: readonly CatMeta[];
  isEnabled(cat: Cat): boolean;
  setEnabled(cat: Cat, on: boolean): void;
  /** substring search over event labels/details, ranked by importance */
  find(query: string, limit?: number): SearchHit[];
  /** how many events are loaded (statics + everything ingested so far) */
  eventCount(): number;
  /** called when lazily-fetched events arrive (host wires it to invalidate) */
  setOnUpdate(fn: () => void): void;
  /** every English UI string (labels/details/headers/eras/cycles), for i18n */
  strings(): string[];
  /** install a label translator (en → localized); default identity */
  setTranslate(fn: (s: string) => string): void;
  /** true when the log (symlog) time axis is active (vs linear) */
  isLogAxis(): boolean;
  /** switch the time axis at runtime (host should re-fit afterwards) */
  setLogAxis(on: boolean): void;
  /** current temporal fold ("none" = continuous axis) */
  getFold(): TimelineFold;
  /**
   * switch the temporal fold at runtime. "year" folds dated modern events
   * into calendar-year rows (worldY = UTC year, x = phase within the year).
   * The host should re-frame afterwards — use tMsForWorld()/worldForTMs()
   * to keep the instant at the viewport center fixed across the switch.
   */
  setFold(fold: TimelineFold, opts?: { animateFrom?: LaneView }): void;
  /** the instant at a world-y under the CURRENT projection (null if none) */
  tMsForWorld(worldY: number): number | null;
  /** folded mode: flash a transient ring at a search hit's (row, phase) */
  setPulse(hit: SearchHit): void;
  /** the calendar-year row range fold-year would cover (dated events + now) */
  foldRowRange(): { min: number; max: number };
  /** per-track folding: fold events inside each track whenever space allows */
  isTrackFold(): boolean;
  setTrackFold(on: boolean): void;
  /** preference: OKLCH heat cells + presence wash in fold grids */
  setHeatCells(on: boolean): void;
  /** preference: glide animation on fold-level changes */
  setGlide(on: boolean): void;
  /** world-y of an instant under the CURRENT projection */
  worldForTMs(tMs: number): number;
  /** the event under a screen point (for hover cards), or null */
  eventAt(
    screenX: number,
    screenY: number,
    view: LaneView,
  ): { title: string; detail?: string; cat: string } | null;
}

/** an event as timeline datasets author them (see Ev for field docs) */
export type TimelineEvent = Ev;
export type TimelineEra = Era;
export type TimelineCycle = Cycle;

/**
 * A swappable dataset behind the timeline engine. The engine (tracks, symlog
 * axis, calendar folds, heat cells, declutter, search) is generic; what the
 * deep-time demo hard-codes — track list, static events, eras, cycles, axis
 * reach, lazy fetchers — arrives here instead. The `fetch` hook runs once per
 * draw; anything it ingests streams in like the deep-time feeds do. The lib
 * itself still does no I/O — datasets that fetch live in demo/host code.
 */
export interface TimelineDataset {
  title: string;
  tracks: CatMeta[];
  statics: Ev[];
  eras?: Era[];
  cycles?: Cycle[];
  /** oldest years-before-present the axis reaches (default: Big Bang) */
  oldestYBP?: number;
  /** years after present the axis extends to (default 1e10) */
  futureYears?: number;
  /**
   * initial-fit window bias, in years before present (top = older edge,
   * bot ≤ 0 reaches into the future). The full extent stays reachable by
   * scrolling — this only frames the opening view, e.g. a git dataset
   * opening on the recent weeks instead of its whole multi-year extent.
   */
  fitYBP?: { top: number; bot: number };
  /** per-frame lazy-loading hook (demo/host side — the engine never fetches) */
  fetch?: (view: LaneView, api: TimelineFetchApi) => void;
}

/** helpers the engine lends a dataset's fetch hook */
export interface TimelineFetchApi {
  /** fetch a URL once per key (dedup + in-flight cap) and ingest the result;
   *  `init` allows non-GET requests (e.g. a GraphQL POST) */
  lazyFetch(
    key: string,
    url: string,
    mapFn: (data: unknown) => Ev[],
    init?: RequestInit,
  ): void;
  /** visible window in years-before-present (top = older edge) */
  winYBP(view: LaneView): { top: number; bot: number };
  /** ISO timestamp of a years-before-present offset */
  isoOf(yBP: number): string;
  /** years-before-present of a Unix-ms instant */
  ybpOfMs(tMs: number): number;
  /** is this track currently toggled on? */
  enabled(cat: string): boolean;
  /** push events straight in (for non-HTTP sources the host already has) */
  ingest(evs: Ev[]): void;
}

export function createTimelineSource(
  opts: { logAxis?: boolean; dataset?: TimelineDataset } = {},
): TimelineSource {
  const ds = opts.dataset;
  let points: Ev[] = (
    ds
      ? [...ds.statics]
      : [...EVENTS, ...LINUX, ...CIV, ...LANGS, ...BORN, ...FUTURE, ...DISASTERS]
  ).sort((a, b) => b.y - a.y);
  // dataset-scoped vocabulary — the deep-time tables are just the default
  const catMeta = ds?.tracks ?? CAT_META;
  const catColor = Object.fromEntries(
    catMeta.map((m) => [m.cat, m.color]),
  ) as Record<Cat, string>;
  const colorOf = (cat: Cat) => catColor[cat] ?? "#888888";
  // mass-known events grow on the discrete dot ladder and brighten on the
  // track's heat ramp — the single-event end of the heat-cell vocabulary.
  // Shared by every glyph path (per-track fold, continuous rail, global
  // fold) so a fold switch never drops the magnitude encoding.
  const massGlyph = (e: Ev, dark: boolean): { r: number; fill: string } => {
    const mb = massBucket(e.mass);
    return {
      r: MASS_DOT_R[mb]!,
      fill: mb
        ? heatRampColor(colorOf(e.cat), MASS_RAMP_N[mb]!, dark)
        : colorOf(e.cat),
    };
  };
  const eras = ds ? (ds.eras ?? []) : ERAS;
  const cycles = ds ? (ds.cycles ?? []) : CYCLES;
  const OLDEST = ds?.oldestYBP ?? BIG_BANG;
  const FUT_HORIZON = ds?.futureYears ?? FUTURE_HORIZON;
  let byCat = new Map<Cat, Ev[]>();
  function reindex() {
    byCat = new Map();
    for (const e of points)
      (byCat.get(e.cat) ?? byCat.set(e.cat, []).get(e.cat)!).push(e);
  }
  reindex();

  // ── adaptive zoom-in limit ────────────────────────────────────────────────
  // The clamp is the rg-merge readability rule applied to zoom: stop where
  // the FINEST precision window in the loaded data stretches to ~4rem —
  // past that, zoom adds pixels but no information. Lazily rescanned when
  // datasets stream in (ingesting minute-precision commits deepens the
  // limit), and axis-aware: on the symlog axis a window's world width
  // depends on how deep in time it sits, so the binding event is the
  // fine-precision one FARTHEST from now.
  const ZOOM_WIN_PX = 64; // the finest window may stretch to ~4rem
  const ZOOM_CEIL = 1e12; // float-safety / runaway-wheel ceiling
  const ZOOM_FALLBACK = 5e6; // no precision data loaded (legacy fixed clamp)
  let zoomScanLen = -1;
  let minLinYr = Infinity; // linear axis: min precision window, in years
  let minLogRatio = Infinity; // log axis: min of window / (LIN + |yBP|)
  function scanZoomPrecision() {
    if (points.length === zoomScanLen) return;
    zoomScanLen = points.length;
    minLinYr = Infinity;
    minLogRatio = Infinity;
    for (const e of points) {
      const win = e.precision?.kind === "calendar" ? precisionWindow(e) : null;
      if (!win) continue;
      const wYr = (win[1] - win[0]) / (SPY * 1000);
      if (!(wYr > 0)) continue;
      if (wYr < minLinYr) minLinYr = wYr;
      const r = wYr / (LIN + Math.abs(e.y));
      if (r < minLogRatio) minLogRatio = r;
    }
  }
  function adaptiveMaxZoom(): number {
    scanZoomPrecision();
    // px(window) = zoom·w/(ln10·(LIN+|y|)) on symlog, zoom·w on linear —
    // solve each for the zoom putting the tightest window at ZOOM_WIN_PX
    const need = logAxis
      ? minLogRatio === Infinity
        ? ZOOM_FALLBACK
        : (ZOOM_WIN_PX * Math.LN10) / minLogRatio
      : minLinYr === Infinity
        ? ZOOM_FALLBACK
        : ZOOM_WIN_PX / minLinYr;
    return Math.min(ZOOM_CEIL, need);
  }

  // ── lazy web fetch: open datasets pulled in at their matching zoom scale ──
  let onUpdate: () => void = () => {};
  const fetchedKeys = new Set<string>();
  const inflightKeys = new Set<string>();
  function ingest(evs: Ev[]) {
    if (!evs.length) return;
    points = points.concat(evs).sort((a, b) => b.y - a.y);
    reindex();
    onUpdate();
  }
  // SPARQL result rows with a usable label + date
  type WdRow = { l: { value: string }; d: { value: string }; sl?: { value: string } };
  function wdRows(data: unknown): WdRow[] {
    const d = data as { results?: { bindings?: WdRow[] } };
    return (d.results?.bindings ?? []).filter(
      (r) => r?.l?.value && r?.d?.value && isFinite(Date.parse(r.d.value)),
    );
  }
  // fetch once per key (dedup + attempted-marker so failures don't re-spam);
  // a small concurrency cap keeps us polite to the open endpoints — blocked
  // fetches simply retry on a later frame via maybeFetch
  const MAX_LAZY_INFLIGHT = 4;
  function lazyFetch(
    key: string,
    url: string,
    mapFn: (data: unknown) => Ev[],
    init?: RequestInit,
  ) {
    if (fetchedKeys.has(key) || inflightKeys.has(key)) return;
    if (inflightKeys.size >= MAX_LAZY_INFLIGHT) return;
    fetchedKeys.add(key);
    inflightKeys.add(key);
    fetch(url, init)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) ingest(mapFn(data));
      })
      .catch(() => {})
      .finally(() => inflightKeys.delete(key));
  }
  const iso = (yBP: number) =>
    new Date((PRESENT_EPOCH - yBP * SPY) * 1000).toISOString();
  const winYBP = (view: LaneView) => ({
    top: yBPof(screenToWorldY(view, -20)), // older edge
    bot: yBPof(screenToWorldY(view, view.height + 20)), // younger/future edge
  });

  // real Linux-kernel commits (GitHub) at the commit scale
  function fetchLinux(view: LaneView) {
    if (!enabled.has("repo")) return;
    const { top, bot } = winYBP(view);
    const b = Math.max(0, bot);
    if (top < 0 || top > 40 || top - b > 6) return; // git-era, narrow
    lazyFetch(
      "linux:" + Math.round(((top + b) / 2) * 3),
      `https://api.github.com/repos/torvalds/linux/commits?since=${iso(top)}&until=${iso(b)}&per_page=40`,
      (data) =>
        (Array.isArray(data) ? data : []).map(
          (c: { commit: { message: string; author: { date: string } } }) => ({
            y: (PRESENT_EPOCH - Date.parse(c.commit.author.date) / 1000) / SPY,
            tMs: Date.parse(c.commit.author.date),
            precision: { kind: "calendar", unit: "minute" },
            label: (String(c.commit.message).split("\n")[0] ?? "").slice(0, 72),
            detail: "torvalds/linux",
            imp: 0.3,
            cat: "repo" as Cat,
            span: 0.5 * DAY,
          }),
        ),
    );
  }

  // real rocket launches — past AND scheduled future (Launch Library 2)
  function fetchLaunches(view: LaneView) {
    if (!enabled.has("cosmic")) return;
    const { top, bot } = winYBP(view);
    // near now: recent past (≤6 yr) through the scheduled future (≥−3 yr)
    if (top < 0 || top > 6 || bot < -3 || top - bot > 9) return;
    lazyFetch(
      "launch:" + Math.round(((top + bot) / 2) * 2),
      `https://ll.thespacedevs.com/2.2.0/launch/?net__gte=${iso(top)}&net__lte=${iso(bot)}&limit=30&mode=list&ordering=-net`,
      (data) => {
        const d = data as { results?: Array<{ name?: string; net?: string }> };
        return (d.results ?? [])
          .filter((l) => l.net)
          .map((l) => ({
            y: (PRESENT_EPOCH - Date.parse(l.net!) / 1000) / SPY,
            tMs: Date.parse(l.net!),
            precision: { kind: "calendar", unit: "minute" },
            label: (l.name ?? "launch").slice(0, 60),
            detail: "🚀 launch",
            imp: 0.32,
            cat: "cosmic" as Cat,
            span: 0.5 * DAY,
          }));
      },
    );
  }

  const WD = "https://query.wikidata.org/sparql?format=json&query=";
  const ceWindow = (view: LaneView) => {
    const { top, bot } = winYBP(view);
    const b = Math.max(0, bot);
    const y1raw = Math.max(1, Math.round(PRESENT_YEAR - top));
    const y2raw = Math.round(PRESENT_YEAR - b) + 1;
    // QUANTIZE the window to a power-of-two year grid: a zoom/focus
    // animation sweeps the view through dozens of raw windows, and since
    // the fetch key derives from y1-y2, un-quantized windows once fired
    // 100+ SPARQL requests in seconds. Snapped windows collapse a sweep
    // into a handful of stable keys (and cached ranges get reused).
    const step = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, (y2raw - y1raw) / 2))));
    const y1 = Math.max(1, Math.floor(y1raw / step) * step);
    const y2 = Math.min(PRESENT_YEAR + 2, Math.ceil(y2raw / step) * step);
    return { top, b, y1, y2 };
  };
  // real dated historical events from Wikidata — broadened beyond battles/wars
  // to treaties, revolutions & massacres. Narrow windows keep SPARQL fast (the
  // fetch fires per window, so panning/zooming fills in the surrounding range).
  function fetchWikidataEvents(view: LaneView) {
    if (!enabled.has("human")) return;
    const { top, b, y1, y2 } = ceWindow(view);
    if (top < 5 || top > 2020 || top - b > 600 || y2 <= y1) return;
    // battles/wars/treaties/revolutions/massacres + pandemics/epidemics/
    // outbreaks/earthquakes/tsunamis/eruptions; P580 (start) alternates
    // with P585 because era-scale events (wars, COVID) carry a start time,
    // not a point in time
    const q =
      `SELECT ?l ?d WHERE { VALUES ?t { wd:Q178561 wd:Q198 wd:Q131569 wd:Q10931 wd:Q3199915 ` +
      `wd:Q12184 wd:Q44512 wd:Q3241045 wd:Q7944 wd:Q8070 wd:Q7692360 } ` +
      `?e wdt:P31 ?t ; rdfs:label ?l . ?e wdt:P585|wdt:P580 ?d . FILTER(LANG(?l)="en") ` +
      `FILTER(?d >= "${y1}-01-01T00:00:00Z"^^xsd:dateTime && ?d < "${y2}-01-01T00:00:00Z"^^xsd:dateTime) } LIMIT 60`;
    lazyFetch(`wde2:${y1}-${y2}`, WD + encodeURIComponent(q), (data) =>
      wdRows(data).map((r) => ({
        y: (PRESENT_EPOCH - Date.parse(r.d.value) / 1000) / SPY,
        tMs: Date.parse(r.d.value),
        precision: { kind: "calendar", unit: "day" },
        label: r.l.value.slice(0, 56),
        detail: "Wikidata",
        imp: 0.42,
        cat: "human" as Cat,
        span: 0.5,
      })),
    );
  }

  // inventions & discoveries (P575) — fills the Tech track across the CE
  function fetchInventions(view: LaneView) {
    if (!enabled.has("tech")) return;
    const { top, b, y1, y2 } = ceWindow(view);
    if (top < 0.5 || top > 1000 || top - b > 400 || y2 <= y1) return;
    const q =
      `SELECT ?l ?d WHERE { ?e wdt:P575 ?d ; rdfs:label ?l . FILTER(LANG(?l)="en") ` +
      `FILTER(?d >= "${y1}-01-01T00:00:00Z"^^xsd:dateTime && ?d < "${y2}-01-01T00:00:00Z"^^xsd:dateTime) } LIMIT 60`;
    lazyFetch(`wdi:${y1}-${y2}`, WD + encodeURIComponent(q), (data) =>
      wdRows(data).map((r) => ({
        y: (PRESENT_EPOCH - Date.parse(r.d.value) / 1000) / SPY,
        tMs: Date.parse(r.d.value),
        // P575 is usually year-grained; a Jan-1 timestamp is a giveaway
        precision: {
          kind: "calendar",
          unit: r.d.value.startsWith(`${new Date(r.d.value).getUTCFullYear()}-01-01T00:00`)
            ? "year"
            : "day",
        },
        label: r.l.value.slice(0, 56),
        detail: "💡 invented",
        imp: 0.4,
        cat: "tech" as Cat,
        span: 0.5,
      })),
    );
  }

  // species first described — fills the Life track from Linnaeus on. The
  // publication year rides as a QUALIFIER on the scientific name (p:P225 /
  // pq:P574); the main-statement P574 is nearly empty (probed 2026-07).
  function fetchSpecies(view: LaneView) {
    if (!enabled.has("bio")) return;
    const { top, b, y1, y2 } = ceWindow(view);
    if (top < 0.5 || top > 280 || top - b > 30 || y2 <= y1 || y1 < 1750) return;
    const q =
      `SELECT ?l ?d WHERE { ?e p:P225 ?st . ?st pq:P574 ?d . ?e rdfs:label ?l . FILTER(LANG(?l)="en") ` +
      `FILTER(?d >= "${y1}-01-01T00:00:00Z"^^xsd:dateTime && ?d < "${y2}-01-01T00:00:00Z"^^xsd:dateTime) } LIMIT 60`;
    lazyFetch(`wds:${y1}-${y2}`, WD + encodeURIComponent(q), (data) =>
      wdRows(data).map((r) => ({
        y: (PRESENT_EPOCH - Date.parse(r.d.value) / 1000) / SPY,
        tMs: Date.parse(r.d.value),
        precision: { kind: "calendar", unit: "year" }, // P574 is a publication YEAR
        label: r.l.value.slice(0, 56),
        detail: "🧬 first described",
        imp: 0.34,
        cat: "bio" as Cat,
        span: 0.5,
      })),
    );
  }

  // dated astronomical phenomena — the whole P31/P279* subtree of Q751989:
  // eclipses (4-7/yr, the calendar-fold showpiece) plus planetary transits,
  // meteors & fireballs, impacts, solar storms… (probed 2026-07: 255 rows /
  // 37 yr in ~2s). Day-precise via P585.
  function fetchAstro(view: LaneView) {
    if (!enabled.has("cosmic")) return;
    const { top, b, y1, y2 } = ceWindow(view);
    if (top < -40 || top > 3000 || top - b > 30 || y2 <= y1) return;
    const q =
      `SELECT ?l ?d WHERE { ?e wdt:P31/wdt:P279* wd:Q751989 . ` +
      `?e wdt:P585 ?d ; rdfs:label ?l . FILTER(LANG(?l)="en") ` +
      `FILTER(?d >= "${y1}-01-01T00:00:00Z"^^xsd:dateTime && ?d < "${y2}-01-01T00:00:00Z"^^xsd:dateTime) } LIMIT 250`;
    lazyFetch(`wda:${y1}-${y2}`, WD + encodeURIComponent(q), (data) =>
      wdRows(data).map((r) => ({
        y: (PRESENT_EPOCH - Date.parse(r.d.value) / 1000) / SPY,
        tMs: Date.parse(r.d.value),
        precision: { kind: "calendar", unit: "day" },
        label: r.l.value.slice(0, 56),
        detail: /eclipse/i.test(r.l.value) ? "🌘 eclipse" : "🌌 astronomy",
        imp: 0.3,
        cat: "cosmic" as Cat,
        span: 0.5,
      })),
    );
  }

  const fetchApi: TimelineFetchApi = {
    lazyFetch,
    winYBP,
    isoOf: iso,
    ybpOfMs: (tMs) => (PRESENT_EPOCH - tMs / 1000) / SPY,
    enabled: (cat) => enabled.has(cat),
    ingest,
  };
  function maybeFetch(view: LaneView) {
    if (ds) {
      ds.fetch?.(view, fetchApi);
      return;
    }
    fetchLinux(view);
    fetchLaunches(view);
    fetchWikidataEvents(view);
    fetchInventions(view);
    fetchSpecies(view);
    fetchAstro(view);
  }

  const enabled = new Set<Cat>(catMeta.map((m) => m.cat));

  // ── axis transform ────────────────────────────────────────────────────────
  // LOG (default): symlog centred at "now" — worldY = ∓log10(1+|yBP|/LIN), so
  // the whole 13.8-Gyr past AND the far future fit on one screen, each decade
  // of time taking a constant span. LIN (1 s) is the linear core near now, so
  // there's no singularity at yBP=0. LINEAR keeps worldY = −yBP (zoom to roam).
  let logAxis = opts.logAxis ?? true; // runtime-toggleable
  const LIN = SEC; // symlog linear threshold: 1 second
  const worldOf = (yBP: number) =>
    logAxis
      ? -Math.sign(yBP) * Math.log10(1 + Math.abs(yBP) / LIN)
      : -yBP;
  const yBPof = (worldY: number) => {
    const s = -worldY;
    return logAxis
      ? Math.sign(s) * (Math.pow(10, Math.abs(s)) - 1) * LIN
      : s;
  };
  // influence LOD threshold, in current world units (years or log-decades)
  const influenceOf = (e: Ev) =>
    e.influence ??
    (logAxis
      ? INFLUENCE_BASE_LOG * Math.pow(e.imp, 3)
      : INFLUENCE_BASE_LINEAR * Math.pow(e.imp, 4));
  const influenceDots = () => (logAxis ? 3 : 12); // dots linger past label cutoff

  // world-span (units) a focus/search should frame around an event — its own
  // uncertainty widened for context, floored so precise events don't over-zoom
  const ctxWorld = (e: Ev) => {
    const s = spanOf(e);
    const w = Math.abs(worldOf(e.y - s) - worldOf(e.y + s));
    return Math.max(w * 15, logAxis ? 1.2 : 1e-9);
  };

  let tr: (s: string) => string = (s) => s; // label translator (i18n)

  // A track's "demand" = proximity-weighted importance mass of its events:
  // near/on-screen important events pull hard, distant ones fade (exp falloff).
  function trackDemand(cat: Cat, view: LaneView): number {
    if (cat === "periodic") {
      let c = 0;
      for (const cy of cycles) {
        const px = cy.period * view.zoomY;
        if (px >= 9 && px <= view.height * 1.6) c++;
      }
      return c * 0.7;
    }
    const H = view.height;
    let d = 0;
    for (const e of points) {
      if (e.cat !== cat) continue;
      const sy = worldToScreenY(view, worldOf(e.y));
      const off = sy < 0 ? -sy : sy > H ? sy - H : 0; // px outside the viewport
      d += e.imp * Math.exp(-off / H);
    }
    return d;
  }

  // Track widths scale with demand, squashed to [W_MIN, W_MAX] via a smooth
  // saturating map D/(D+C) (Michaelis–Menten). W_MAX/W_MIN caps how much a hot
  // track can dominate; the map is continuous in the view so widths glide.
  const W_MIN = 1;
  const W_MAX = 4;
  const DEMAND_HALF = 1.3; // demand at which a track reaches half its extra width
  const activeTracks = (view: LaneView) => {
    const active = catMeta.filter((m) => enabled.has(m.cat));
    const weights = active.map((m) => {
      const D = trackDemand(m.cat, view);
      return W_MIN + (W_MAX - W_MIN) * (D / (D + DEMAND_HALF));
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const availW = view.width - TRACK_X0;
    let x = TRACK_X0;
    return active.map((m, i) => {
      const w = (availW * weights[i]!) / sum;
      const track = { meta: m, x0: x, w };
      x += w;
      return track;
    });
  };

  function draw(ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv) {
    const { theme } = env;
    const W = view.width;
    const H = view.height;
    const topW = screenToWorldY(view, 0);
    const botW = screenToWorldY(view, H);
    foldLabelRects = []; // repopulated by whichever event path draws labels
    foldHeaderAxes.length = 0; // pseudo-x-axes queued by folding tracks
    heatCells.clear(); // per-cell densities, repopulated by folding tracks

    maybeFetch(view); // lazily pull real commits when zoomed to their scale
    drawEras(ctx, view, theme, H);
    drawRuler(ctx, view, theme, W, H, topW, botW);

    const tracks = activeTracks(view);
    // faint track lanes + separators
    for (const t of tracks) {
      ctx.fillStyle = withAlpha(t.meta.color, 0.04);
      ctx.fillRect(t.x0, 0, t.w, H);
      ctx.strokeStyle = withAlpha(theme.textFaint, 0.18);
      ctx.beginPath();
      ctx.moveTo(t.x0 + 0.5, 0);
      ctx.lineTo(t.x0 + 0.5, H);
      ctx.stroke();
    }

    drawNow(ctx, view, theme, tracks.length ? tracks[0]!.x0 : TRACK_X0, W);

    for (const t of tracks) {
      if (t.meta.cat === "periodic")
        drawPeriodic(ctx, view, theme, t.x0, t.w, H, topW, botW);
      else {
        drawTrackFoldBands(ctx, view, theme, t.x0, t.w, H, t.meta.cat);
        drawTrackEvents(ctx, view, theme, t.x0, t.w, H, topW, botW, t.meta.cat);
      }
    }

    // sticky header strip on top of everything
    ctx.fillStyle = withAlpha(theme.background, 0.82);
    ctx.fillRect(TRACK_X0, 0, W - TRACK_X0, HEADER_H);
    ctx.strokeStyle = withAlpha(theme.textFaint, 0.2);
    ctx.beginPath();
    ctx.moveTo(TRACK_X0, HEADER_H + 0.5);
    ctx.lineTo(W, HEADER_H + 0.5);
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    for (const t of tracks) {
      ctx.fillStyle = t.meta.color;
      ctx.fillText(fit(ctx, tr(t.meta.label), t.w - 8), t.x0 + 6, HEADER_H / 2);
    }
    // folding tracks: pseudo-x-axis slot labels share the sticky strip
    // (skipping the zone the track's own name occupies)
    ctx.font = "9px ui-monospace, Menlo, monospace";
    for (const ax of foldHeaderAxes) {
      for (let m2 = 0; m2 < ax.div.slots; m2 += ax.every) {
        const x = ax.x0 + (m2 / ax.div.slots) * ax.contentW + 2;
        if (x < ax.x0 + 62) continue; // leave room for the track name
        ctx.fillStyle = withAlpha(theme.textFaint, 0.95);
        ctx.fillText(tr(ax.div.slotLabel(m2)), x, HEADER_H / 2);
      }
    }

    drawOffscreen(ctx, theme, W, H, topW, botW);
  }

  function drawRuler(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    theme: RgTheme,
    W: number,
    H: number,
    topW: number,
    botW: number,
  ) {
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    if (logAxis) {
      // ticks at round times (past & future), positioned by their log worldY,
      // deconflicted by on-screen gap; labels are relative durations
      const ticks: number[] = [];
      for (const t of NICE_TIMES) ticks.push(t, -t);
      ticks.sort((a, b) => worldOf(a) - worldOf(b)); // top → bottom
      let lastSy = -Infinity;
      for (const yBP of ticks) {
        const sy = worldToScreenY(view, worldOf(yBP));
        if (sy < -20 || sy > H + 20 || sy - lastSy < 30) continue;
        lastSy = sy;
        ctx.strokeStyle = withAlpha(theme.textFaint, 0.12);
        ctx.beginPath();
        ctx.moveTo(RULER_W, sy + 0.5);
        ctx.lineTo(W, sy + 0.5);
        ctx.stroke();
        ctx.fillStyle = theme.textMuted;
        ctx.textAlign = "right";
        ctx.fillText((yBP < 0 ? "+" : "") + fmtDur(Math.abs(yBP)), RULER_W - 6, sy);
      }
      return;
    }
    let step = STEPS[0]!;
    for (const s of STEPS) {
      if (s * view.zoomY >= 66) step = s;
      else break;
    }
    for (let g = Math.floor(topW / step) * step; g <= botW + step; g += step) {
      const sy = worldToScreenY(view, g);
      if (sy < -20 || sy > H + 20) continue;
      ctx.strokeStyle = withAlpha(theme.textFaint, 0.12);
      ctx.beginPath();
      ctx.moveTo(RULER_W, sy + 0.5);
      ctx.lineTo(W, sy + 0.5);
      ctx.stroke();
      ctx.fillStyle = theme.textMuted;
      ctx.textAlign = "right";
      ctx.fillText(fmtLabel(-g, step), RULER_W - 6, sy);
    }
  }

  function drawEras(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    theme: RgTheme,
    H: number,
  ) {
    for (const era of eras) {
      const yTop = worldToScreenY(view, worldOf(era.from));
      const yBot = worldToScreenY(view, worldOf(era.to));
      if (yBot < -2 || yTop > H + 2) continue;
      const x = ERA_X + era.depth * ERA_COLW;
      const a = Math.max(yTop, -2);
      const b = Math.min(yBot, H + 2);
      ctx.fillStyle = withAlpha(era.color, 0.55);
      ctx.fillRect(x, a, ERA_COLW, b - a);
      ctx.strokeStyle = withAlpha(theme.background, 0.6);
      ctx.strokeRect(x + 0.5, a + 0.5, ERA_COLW - 1, b - a - 1);
      if (b - a > 44) {
        const cy = (a + b) / 2;
        ctx.save();
        ctx.translate(x + ERA_COLW / 2, cy);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = theme.text;
        ctx.font = "11px ui-monospace, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const el = tr(era.label);
        ctx.fillText(ctx.measureText(el).width < b - a - 8 ? el : "", 0, 0);
        ctx.restore();
      }
    }
  }

  function drawNow(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    theme: RgTheme,
    x0: number,
    W: number,
  ) {
    const sy = worldToScreenY(view, 0);
    if (sy < -2 || sy > view.height + 2) return;
    ctx.strokeStyle = withAlpha(theme.accent, 0.9);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, sy + 0.5);
    ctx.lineTo(W, sy + 0.5);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = theme.accent;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`now · ${PRESENT_YEAR}`, W - 6, sy - 2);
  }

  /** the fold GRID inside a folding track: vertical phase-slot columns (with
   *  ghost placeholders for slots a short cycle doesn't have), horizontal
   *  cycle-band separators, and a pseudo-x-axis of slot labels at the top —
   *  the finest level readable at the viewport center draws its chrome */
  function drawTrackFoldBands(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    theme: RgTheme,
    x0: number,
    w: number,
    H: number,
    cat: Cat,
  ) {
    if (!trackFold || fold !== "none") return;
    const rem = remPx();
    if (!trackWideEnough(cat, w, rem)) return;
    const contentW = trackContentW(w, rem);
    const tCenter = tMsOfYbp(yBPof(screenToWorldY(view, H / 2)));
    if (!Number.isFinite(tCenter) || !Number.isFinite(new Date(tCenter).getTime())) return;
    for (const lf of LADDER_FINE_FIRST) {
      const fv = FOLD_VIEWS[lf];
      const div = chooseDivision(fv, contentW, rem);
      if (!div) continue;
      const p = fv.projector.project(tCenter);
      if (!p) continue;
      const start = foldRowStartMs(lf, p.rowIndex);
      const end = foldRowStartMs(lf, p.rowIndex + 1);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const yTop0 = worldToScreenY(view, worldOf(ybpOfTMs(start)));
      const yBot0 = worldToScreenY(view, worldOf(ybpOfTMs(end)));
      if (Math.abs(yBot0 - yTop0) < rem) continue;

      const gx = (phase: number) => trackContentX0(x0, rem) + phase * contentW;

      // aggregate the two heat channels for this track at THIS level:
      // count = integer nominal events per cell (labels, dot suppression,
      // lightness ramp); presence = mass-conserving float from TINT-state
      // events whose precision window dwarfs the view (faint wash only —
      // never rendered as a number). Interval-state events skip both: they
      // are visible as row fragments instead.
      const cells = new Map<string, number>();
      const ramp = new Map<string, number>(); // mass-weighted shade channel
      const presence = new Map<string, number>();
      heatCells.set(cat, { level: lf, cells, ramp, presence });
      const list = byCat.get(cat) ?? [];
      const centerRow = fv.projector.project(tCenter)!.rowIndex;
      const vis = visibleRowRange(lf, view, H, centerRow); // projected endpoints
      for (const e of list) {
        const t2 = tMsOfEv(e);
        if (t2 == null) continue;
        const pe = fv.projector.project(t2);
        if (!pe) continue;
        // classify at the event's OWN resolved level — the single source of
        // truth shared with the glyph pass and hit-testing (codex review P0);
        // an event resolved at a different level than this grid renders as
        // its own glyph and skips these center-level cells entirely
        const fpAgg = trackFoldPos(e, view, x0, w);
        if (!fpAgg) continue;
        const { lod, win } = classifyEv(e, fpAgg.level, fpAgg.slots, fpAgg.bandPx, H);
        // level mismatch (symlog variance): point/interval render as their
        // own glyph/band at their own level — but TINT has no glyph, so its
        // existence must still be carried by THIS grid's cells (codex P0):
        // classification truth stays at the event's level, the encoding uses
        // the center grid's geometry.
        if (fpAgg.level !== lf && lod !== "tint") continue;
        if (lod === "point" || !win) {
          const slot = Math.floor(Math.min(0.999999, pe.phase0) * div.slots);
          const key = `${pe.rowIndex}:${slot}`;
          cells.set(key, (cells.get(key) ?? 0) + 1);
          // shade channel: mass-weighted so a 2k-line afternoon outglows a
          // typo streak; the label/dot-suppression stay honest counts
          ramp.set(key, (ramp.get(key) ?? 0) + massWeight(e.mass));
          continue;
        }
        if (lod !== "tint") continue; // interval renders as fragments
        // presence: clip the window's rows to the visible range (caller-owned
        // bounding per temporal.ts contract), spread overlap/window weight.
        // Display phases approximate elapsed time here — acceptable for a wash.
        const winRows = (win[1] - win[0]) / FOLD_PERIOD_MS[lf]!;
        const r0 = Math.max(fv.projector.project(win[0])?.rowIndex ?? vis.r0, vis.r0);
        const r1 = Math.min(fv.projector.project(win[1] - 1)?.rowIndex ?? vis.r1, vis.r1);
        const nSlots = Math.ceil(div.slots);
        for (let row = r0; row <= r1 && row - r0 < 300; row++) {
          const perRow = 1 / winRows; // this row's share of the whole window
          // slot shares use each cell's ACTUAL phase width so fractional
          // divisions (month's 31/7 week cells) conserve mass — the tail
          // cell weighs its 3 days, not a full seventh (codex review)
          for (let sl = 0; sl < nSlots; sl++) {
            const share = (Math.min(sl + 1, div.slots) - sl) / div.slots;
            if (share <= 0) continue;
            const key = `${row}:${sl}`;
            presence.set(key, (presence.get(key) ?? 0) + perRow * share);
          }
        }
      }
      const darkTheme = srgbToOklch(theme.background as string).L < 0.5;
      const slotWpx = contentW / div.slots;
      // presence wash: bounded alpha, composed UNDER the count cells — the
      // "an imprecise event exists somewhere here" channel, never a number
      for (const [key, p] of heatEnabled ? presence : new Map<string, number>()) {
        if (cells.has(key) || p <= 0) continue; // count cells dominate (documented)
        const [rowS, slotS] = key.split(":");
        const row = Number(rowS);
        const slot = Number(slotS);
        const ms0 = foldRowStartMs(lf, row);
        const ms1 = foldRowStartMs(lf, row + 1);
        if (!Number.isFinite(ms0) || !Number.isFinite(ms1)) continue;
        const ya = worldToScreenY(view, worldOf(ybpOfTMs(ms0)));
        const yb = worldToScreenY(view, worldOf(ybpOfTMs(ms1)));
        const cy0 = Math.max(Math.min(ya, yb), HEADER_H);
        const cy1 = Math.min(Math.max(ya, yb), H);
        if (cy1 <= cy0) continue;
        // perceptible floor + bounded ramp: the conserved p can be ~1e-4 for
        // exactly the events tint exists for (codex review P0) — a tint-only
        // event must never be invisible; magnitude still modulates above it
        ctx.fillStyle = withAlpha(colorOf(cat), 0.07 + 0.23 * (1 - Math.exp(-p * 12)));
        const cwP = ((Math.min(slot + 1, div.slots) - slot) / div.slots) * contentW;
        ctx.fillRect(gx(slot / div.slots), cy0, Math.max(0, cwP), cy1 - cy0);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const [key, n] of heatEnabled ? cells : new Map<string, number>()) {
        const [rowS, slotS] = key.split(":");
        const row = Number(rowS);
        const slot = Number(slotS);
        const ms0 = foldRowStartMs(lf, row);
        const ms1 = foldRowStartMs(lf, row + 1);
        if (!Number.isFinite(ms0) || !Number.isFinite(ms1)) continue;
        const ya = worldToScreenY(view, worldOf(ybpOfTMs(ms0)));
        const yb = worldToScreenY(view, worldOf(ybpOfTMs(ms1)));
        const cy0 = Math.max(Math.min(ya, yb), HEADER_H);
        const cy1 = Math.min(Math.max(ya, yb), H);
        if (cy1 <= cy0) continue;
        ctx.fillStyle = heatCellColor(cat, Math.max(1, Math.round(ramp.get(key) ?? n)), darkTheme);
        const cwN = ((Math.min(slot + 1, div.slots) - slot) / div.slots) * contentW;
        ctx.fillRect(gx(slot / div.slots), cy0, Math.max(0, cwN), cy1 - cy0);
        // selective direct label: the count, only when the cell affords it
        if (n > HEAT_DOT_MAX && cwN >= 2 * rem && cy1 - cy0 >= 1.1 * rem) {
          ctx.fillStyle = darkTheme ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.7)";
          ctx.font = "9px ui-monospace, Menlo, monospace";
          ctx.fillText(String(n), gx(slot / div.slots) + cwN / 2, (cy0 + cy1) / 2);
        }
      }
      ctx.textAlign = "left";

      // vertical slot columns — every column gets a crisp 1px border, and
      // boundaries of the NEXT-COARSER division draw 更醒目: quarter lines
      // among months, week lines among days, daypart lines among hours.
      // Identical x in every band (max-slot phases), so identical wall times
      // align down the whole track.
      const divIdx = fv.divisions.indexOf(div);
      const coarser = fv.divisions[divIdx + 1];
      const majorEvery = coarser ? Math.max(1, Math.round(div.slots / coarser.slots)) : div.labelEvery;
      ctx.lineWidth = 1;
      for (let m2 = 1; m2 < div.slots; m2++) {
        const major = m2 % majorEvery === 0;
        ctx.strokeStyle = withAlpha(theme.textFaint, major ? 0.55 : 0.26);
        const x = gx(m2 / div.slots);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, HEADER_H);
        ctx.lineTo(Math.round(x) + 0.5, H);
        ctx.stroke();
      }

      // pseudo-x-axis: slot labels live in the sticky header strip (drawn
      // last, above everything) — queue this track's axis for that pass
      let every = div.labelEvery;
      while ((contentW / div.slots) * every < 30 && every < div.slots) every *= 2;
      foldHeaderAxes.push({ x0: trackContentX0(x0, rem), contentW, div, every });

      // horizontal cycle-band separators + y-axis row labels + month ghosts
      const drawRow = (row: number): number | null => {
        const ms = foldRowStartMs(lf, row);
        if (!Number.isFinite(ms)) return null;
        const y = worldToScreenY(view, worldOf(ybpOfTMs(ms)));
        if (y >= HEADER_H - 2 && y <= H + 2) {
          const strength = boundaryStrength(ms);
          ctx.strokeStyle = withAlpha(theme.textFaint, Math.min(strength, 0.95));
          ctx.lineWidth = strength >= 0.95 ? 2 : strength >= 0.85 ? 1.6 : 1;
          ctx.beginPath();
          ctx.moveTo(x0 + 2, Math.round(y) + 0.5);
          ctx.lineTo(x0 + w - 4, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        // y axis: which cycle this band IS — labeled at the band's top-left
        {
          const nextMs = foldRowStartMs(lf, row + 1);
          if (Number.isFinite(nextMs)) {
            const y1 = worldToScreenY(view, worldOf(ybpOfTMs(nextMs)));
            const top = Math.min(y, y1);
            const bandPx = Math.abs(y1 - y);
            if (bandPx >= 13 && top + 8 >= HEADER_H && top <= H) {
              const label = fv.projector.project(ms)?.rowLabel;
              if (label) {
                ctx.font = "9px ui-monospace, Menlo, monospace";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillStyle = withAlpha(theme.textFaint, 0.95);
                ctx.fillText(label, x0 + 4, top + Math.min(bandPx / 2, 9));
              }
            }
          }
        }
        // ghost slots: a 28..30-day month leaves its 29..31 columns blank —
        // dim the placeholder region so alignment reads as intentional
        if (lf === "month") {
          const nextMs = foldRowStartMs(lf, row + 1);
          if (Number.isFinite(nextMs)) {
            const y1 = worldToScreenY(view, worldOf(ybpOfTMs(nextMs)));
            const year = Math.floor(row / 12);
            const dim = new Date(Date.UTC(year, (((row % 12) + 12) % 12) + 1, 0)).getUTCDate();
            if (dim < 31) {
              const a = Math.max(Math.min(y, y1), HEADER_H);
              const b = Math.min(Math.max(y, y1), H);
              if (b > a) {
                ctx.fillStyle = withAlpha(theme.textFaint, 0.07);
                ctx.fillRect(gx(dim / 31), a, gx(1) - gx(dim / 31), b - a);
              }
            }
          }
        }
        return y;
      };
      for (let row = p.rowIndex, i = 0; i < 120; i++, row--) {
        const y = drawRow(row);
        if (y == null || y < HEADER_H - 2) break;
      }
      for (let row = p.rowIndex + 1, i = 0; i < 120; i++, row++) {
        const y = drawRow(row);
        if (y == null || y > H + 2) break;
      }
      return; // finest readable level only
    }
  }

  function drawTrackEvents(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    theme: RgTheme,
    x0: number,
    w: number,
    H: number,
    topW: number,
    botW: number,
    cat: Cat,
  ) {
    const list = byCat.get(cat);
    if (!list) return;
    const darkT = srgbToOklch(theme.background as string).L < 0.5;
    const massDot = (e: Ev) => massGlyph(e, darkT);
    const color = colorOf(cat);
    const vis: Array<{ e: Ev; sy: number }> = [];
    for (const e of list) {
      const wy = worldOf(e.y);
      if (wy < topW || wy > botW) continue;
      vis.push({ e, sy: worldToScreenY(view, wy) });
    }
    vis.sort((a, b) => b.e.imp - a.e.imp);
    const placed: number[] = [];
    const placedRects: { x0: number; x1: number; y: number }[] = [];
    let anyGliding = false;
    const cx = x0 + 7;
    const vspan = view.height / view.zoomY; // visible time-span (world years)
    ctx.textBaseline = "middle";
    for (const { e, sy } of vis) {
      if (sy < HEADER_H - 2 || sy > H + 2) continue;
      const infl = influenceOf(e);
      if (vspan > infl * influenceDots()) continue; // out of influence → hidden
      const future = e.cat === "future";
      const inScale = vspan <= infl; // zoomed in enough to earn a label

      // per-track fold: a dated event whose cycle band is readable quantizes
      // to the band and takes its phase-x — same helper the hit-test uses
      const fp = trackFoldPos(e, view, x0, w);
      if (fp) {
        // precision-aware: classification at the EVENT'S OWN fold level —
        // the same level trackFoldPos resolved — so aggregation, glyphs and
        // hit-testing can never disagree (codex review P0). Interval-state
        // events render as row fragments; tint-state events left the glyph
        // layer entirely (presence wash carries them).
        const cls = classifyEv(e, fp.level, fp.slots, fp.bandPx, H);
        if (cls.lod === "tint") continue;
        if (cls.lod === "interval") {
          const win = cls.win;
          if (win) {
            const rem2 = remPx();
            const contentW2 = trackContentW(w, rem2);
            const cx0 = trackContentX0(x0, rem2);
            // pre-clip the window IN TIME to the visible rows before
            // projecting — projectWindow has no internal row cap by contract
            const { r0, r1 } = visibleRowRange(fp.level, view, H, fp.row);
            const clipA = Math.max(win[0], foldRowStartMs(fp.level, r0));
            const clipB = Math.min(win[1], foldRowStartMs(fp.level, r1 + 1));
            const frags = clipB > clipA ? projectWindow(fp.level, clipA, clipB) : [];
            ctx.fillStyle = withAlpha(color, 0.28);
            for (const fr of frags.slice(0, 200)) {
              const ms0 = foldRowStartMs(fp.level, fr.rowIndex);
              const ms1 = foldRowStartMs(fp.level, fr.rowIndex + 1);
              if (!Number.isFinite(ms0) || !Number.isFinite(ms1)) continue;
              const ya = worldToScreenY(view, worldOf(ybpOfTMs(ms0)));
              const yb = worldToScreenY(view, worldOf(ybpOfTMs(ms1)));
              const fy0 = Math.max(Math.min(ya, yb) + 1, HEADER_H);
              const fy1 = Math.min(Math.max(ya, yb) - 1, H);
              if (fy1 <= fy0) continue;
              ctx.fillRect(cx0 + fr.phase0 * contentW2, fy0, Math.max(2, (fr.phase1 - fr.phase0) * contentW2), fy1 - fy0);
            }
            // nominal tick + label at the representative instant, for provenance
            ctx.beginPath();
            ctx.arc(fp.x, fp.y, 2, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            if (inScale) {
              ctx.font = "12px ui-monospace, Menlo, monospace";
              ctx.textAlign = "left";
              const text = fit(ctx, tr(e.label), x0 + w - fp.x - 12);
              const lx0 = fp.x + 6;
              const lx1 = lx0 + ctx.measureText(text).width + 6;
              if (!placedRects.some((p) => Math.abs(p.y - fp.y) < 12 && lx0 < p.x1 && lx1 > p.x0)) {
                placedRects.push({ x0: lx0, x1: lx1, y: fp.y });
                foldLabelRects.push({ x0: lx0, x1: lx1, y: fp.y, e });
                ctx.fillStyle = future ? theme.textDim : theme.text;
                ctx.fillText(text, lx0, fp.y);
              }
            }
          }
          continue;
        }
        // dense cells are represented by their heat shade + count label —
        // individual dots would just overplot (hover still resolves them)
        const hc = heatCells.get(e.cat);
        if (heatEnabled && hc && hc.level === fp.level && (hc.cells.get(`${fp.row}:${fp.slot}`) ?? 0) > HEAT_DOT_MAX) {
          glide.delete(e); // no stale glide origin while represented by the cell
          continue;
        }
        const g = glidePos(e, `fold:${fp.level}`, fp.x, fp.y);
        if (g.moving) anyGliding = true;
        const md = massDot(e);
        ctx.beginPath();
        ctx.arc(g.x, g.y, md.r, 0, Math.PI * 2);
        if (future) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.lineWidth = 1;
        } else {
          ctx.fillStyle = md.fill;
          ctx.fill();
        }
        if (inScale && !g.moving) {
          ctx.font = "12px ui-monospace, Menlo, monospace";
          ctx.textAlign = "left";
          const text = fit(ctx, tr(e.label), x0 + w - fp.x - 12);
          const lx0 = fp.x + 6;
          const lx1 = lx0 + ctx.measureText(text).width + 6;
          if (!placedRects.some((p) => Math.abs(p.y - fp.y) < 12 && lx0 < p.x1 && lx1 > p.x0)) {
            placedRects.push({ x0: lx0, x1: lx1, y: fp.y });
            foldLabelRects.push({ x0: lx0, x1: lx1, y: fp.y, e });
            ctx.fillStyle = future ? theme.textDim : theme.text;
            ctx.fillText(text, lx0, fp.y);
          }
        }
        continue;
      }

      const labeled =
        inScale && !placed.some((p) => Math.abs(p - sy) < LABEL_GAP);
      if (!labeled) {
        // presence hint: a small dim dot so hidden events aren't invisible.
        // Known mass keeps its rung (half-scale) so losing the label doesn't
        // snap a big commit down to the same speck as a typo (codex review)
        const g = glidePos(e, "rail", cx, sy);
        if (g.moving) anyGliding = true;
        const mb = massBucket(e.mass);
        ctx.beginPath();
        ctx.arc(g.x, g.y, 1.5 + mb * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(mb ? massDot(e).fill : color, 0.5);
        ctx.fill();
        continue;
      }
      placed.push(sy);
      const span = spanOf(e);
      const yTop = span > 0 ? worldToScreenY(view, worldOf(e.y + span)) : sy;
      const yBot = span > 0 ? worldToScreenY(view, worldOf(e.y - span)) : sy;
      if (span > 0 && yBot - yTop >= 10) {
        // fuzzy time → soft uncertainty band (a blurred interval) + nominal line
        const a = Math.max(yTop, -2);
        const b = Math.min(yBot, H + 2);
        const grad = ctx.createLinearGradient(0, yTop, 0, yBot);
        grad.addColorStop(0, withAlpha(color, 0));
        grad.addColorStop(0.5, withAlpha(color, future ? 0.22 : 0.34));
        grad.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(cx - 7, a, 14, b - a);
        ctx.strokeStyle = withAlpha(color, future ? 0.55 : 0.85);
        ctx.beginPath(); // nominal-time tick at the band centre
        ctx.moveTo(cx - 6, sy + 0.5);
        ctx.lineTo(cx + 6, sy + 0.5);
        ctx.stroke();
      } else {
        const g = glidePos(e, "rail", cx, sy); // registers the glide origin
        if (g.moving) anyGliding = true;
        const md = massDot(e);
        ctx.beginPath();
        ctx.arc(g.x, g.y, md.r, 0, Math.PI * 2);
        if (future) {
          ctx.strokeStyle = color; // hollow dot marks a prediction
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.lineWidth = 1;
        } else {
          ctx.fillStyle = md.fill;
          ctx.fill();
        }
      }
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = future ? theme.textDim : theme.text;
      ctx.fillText(fit(ctx, tr(e.label), w - 18), cx + 8, sy);
      // detail on a second line when the track has spare vertical room
      if (e.detail) {
        const nextGap = placed.every((p) => p === sy || Math.abs(p - sy) > 26);
        if (nextGap) {
          ctx.font = "9px ui-monospace, Menlo, monospace";
          ctx.fillStyle = theme.textMuted;
          ctx.fillText(fit(ctx, tr(e.detail), w - 18), cx + 8, sy + 11);
        }
      }
    }
    if (anyGliding) onUpdate(); // pump frames until every glide lands
  }

  function drawPeriodic(
    ctx: CanvasRenderingContext2D,
    view: LaneView,
    theme: RgTheme,
    x0: number,
    w: number,
    H: number,
    topW: number,
    botW: number,
  ) {
    // visible time window (years BP); ticks are computed in TIME then mapped
    // through worldOf, so this works on both linear and log axes
    const topYBP = yBPof(topW);
    const botYBP = Math.max(0, yBPof(botW));
    const midYBP = (topYBP + botYBP) / 2 || 1;
    // a cycle is "active" when its period is locally resolvable on screen
    const localPx = (c: Cycle) =>
      Math.abs(
        worldToScreenY(view, worldOf(midYBP)) -
          worldToScreenY(view, worldOf(midYBP + c.period)),
      );
    const active = cycles.filter((c) => {
      const px = localPx(c);
      return px >= 6 && px <= H * 1.6;
    });
    if (!active.length) {
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillStyle = theme.textFaint;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("—", x0 + w / 2, HEADER_H + 6);
      return;
    }
    const sub = w / active.length;
    active.forEach((c, i) => {
      const cx = x0 + i * sub + sub / 2;
      const lo = Math.max(botYBP, c.to ?? 0);
      const hi = Math.min(topYBP, c.from ?? OLDEST);
      ctx.strokeStyle = withAlpha(c.color, 0.7);
      ctx.lineWidth = 1;
      let n = 0;
      let lastSy = Infinity;
      const first = Math.floor(lo / c.period);
      const last = Math.ceil(hi / c.period);
      for (let k = first; k <= last && n < 400; k++, n++) {
        const sy = worldToScreenY(view, worldOf(k * c.period));
        if (sy < HEADER_H || sy > H || Math.abs(sy - lastSy) < 3) continue;
        lastSy = sy;
        ctx.beginPath();
        ctx.moveTo(cx - 4, sy + 0.5);
        ctx.lineTo(cx + 4, sy + 0.5);
        ctx.stroke();
      }
      // rotated cycle name + period
      ctx.save();
      ctx.translate(cx, Math.min(H - 8, HEADER_H + 60));
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = c.color;
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`${tr(c.label)} · ${fmtDur(c.period)}`, 0, 0);
      ctx.restore();
    });
  }

  function drawOffscreen(
    ctx: CanvasRenderingContext2D,
    theme: RgTheme,
    W: number,
    H: number,
    topW: number,
    botW: number,
  ) {
    // notable enabled events beyond each edge (same-or-coarser scale)
    let aboveN = 0;
    let belowN = 0;
    let above: Ev | null = null; // nearest-to-edge notable above
    let below: Ev | null = null;
    for (const e of points) {
      if (!enabled.has(e.cat)) continue;
      const wy = worldOf(e.y);
      if (wy < topW) {
        aboveN++;
        if (e.imp >= 0.6 && (!above || wy > worldOf(above.y))) above = e;
      } else if (wy > botW) {
        belowN++;
        if (e.imp >= 0.6 && (!below || wy < worldOf(below.y))) below = e;
      }
    }
    const cx = (TRACK_X0 + W) / 2;
    if (aboveN) {
      const dist = above ? fmtDur(Math.abs(above.y - yBPof(topW))) : "";
      badge(ctx, theme, cx, HEADER_H + 12, "▲", above ? tr(above.label) : undefined, dist, aboveN);
    }
    if (belowN) {
      const dist = below ? fmtDur(Math.abs(yBPof(botW) - below.y)) : "";
      badge(ctx, theme, cx, H - 12, "▼", below ? tr(below.label) : undefined, dist, belowN);
    }
  }

  function badge(
    ctx: CanvasRenderingContext2D,
    theme: RgTheme,
    cx: number,
    cy: number,
    chevron: string,
    label: string | undefined,
    dist: string,
    count: number,
  ) {
    const text =
      `${chevron} ` +
      (label ? `${label} · ${dist} · ` : "") +
      `+${count}`;
    ctx.font = "11px ui-monospace, Menlo, monospace";
    const tw = ctx.measureText(text).width;
    const pad = 8;
    const x = cx - (tw + pad * 2) / 2;
    ctx.fillStyle = withAlpha(theme.background, 0.9);
    ctx.strokeStyle = withAlpha(theme.accent, 0.5);
    ctx.beginPath();
    ctx.roundRect(x, cy - 10, tw + pad * 2, 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.textDim;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + pad, cy);
  }

  // ── temporal fold (v1: fold-year) — integration/UX layer ─────────────────
  // Projection math lives in ./temporal.js (codex-owned, pure + tested); this
  // side owns the Ev→tMs gate, layout, LOD, and chrome wiring.
  let fold: TimelineFold = "none";
  /**
   * The instant an event may be folded at: its explicit `tMs`, or nothing.
   * There is deliberately NO fallback from `y` — an age-derived coordinate
   * cannot recover calendar precision, and fold-year must not visually assert
   * a month/day the data doesn't have (bare-year events like "Transistor
   * (1947)" stay on the continuous axis / future approx gutter).
   */
  const tMsOfEv = (e: Ev): number | null =>
    e.cat === "periodic" ? null : evTimestampMs(e);
  const tMsOfYbp = (yBP: number) => (PRESENT_EPOCH - yBP * SPY) * 1000;
  const ybpOfTMs = (tMs: number) => (PRESENT_EPOCH - tMs / 1000) / SPY;
  /** folded row range: the fold rows covered by foldable events (+ now).
   *  When unfolded this reports YEAR rows (hosts gate auto-fold with it). */
  const foldRows = () => {
    const proj = (fold === "none" ? FOLD_VIEWS.year : foldView()).projector;
    const nowRow = proj.project(PRESENT_EPOCH * 1000)?.rowIndex ?? 0;
    let min = Infinity;
    let max = -Infinity;
    for (const e of points) {
      const t = tMsOfEv(e);
      if (t == null) continue;
      const p = proj.project(t);
      if (!p) continue;
      if (p.rowIndex < min) min = p.rowIndex;
      if (p.rowIndex > max) max = p.rowIndex;
    }
    if (min > max) return { min: nowRow - 10, max: nowRow };
    // the now-marker row and "today" orientation must always be in extent
    return { min: Math.min(min, nowRow), max: Math.max(max, nowRow) };
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAYPARTS = ["Night", "Morning", "Afternoon", "Evening"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  /** a slot division of a fold row: how the phase axis subdivides. Rows can
   *  offer several, fine→coarse — the finest whose columns stay ≥1rem wide
   *  wins (taku: year shows quarters when 12 months don't fit; month shows
   *  W1..W5 weeks until a super-wide track affords 31 day columns; day shows
   *  the TODO's four dayparts when 24 hour columns don't fit). Event x comes
   *  from the continuous phase, so the division changes only the chrome and
   *  the heat-cell aggregation, never positions. */
  interface FoldDivision {
    slots: number;
    slotLabel: (i: number) => string;
    labelEvery: number;
  }
  const FOLD_VIEWS: Record<
    Exclude<TimelineFold, "none">,
    { projector: (typeof foldYearProjector); divisions: FoldDivision[] }
  > = {
    year: {
      projector: foldYearProjector,
      divisions: [
        { slots: 12, slotLabel: (i) => MONTHS[i]!, labelEvery: 1 },
        { slots: 4, slotLabel: (i) => `Q${i + 1}`, labelEvery: 1 },
      ],
    },
    month: {
      projector: foldMonthProjector,
      divisions: [
        { slots: 31, slotLabel: (i) => String(i + 1), labelEvery: 5 },
        // 7-day week slots over the 31-day measure: W5 is the short tail
        { slots: 31 / 7, slotLabel: (i) => `W${i + 1}`, labelEvery: 1 },
      ],
    },
    // single-letter weekday initials read at any slot width (Monday-start;
    // weekStartsOn config is a TODO — Sunday-start would read SMTWTFS)
    week: {
      projector: foldWeekProjector,
      divisions: [{ slots: 7, slotLabel: (i) => WDAYS[i]![0]!, labelEvery: 1 }],
    },
    day: {
      projector: foldDayProjector,
      divisions: [
        { slots: 24, slotLabel: (i) => `${p2(i)}h`, labelEvery: 3 },
        { slots: 4, slotLabel: (i) => DAYPARTS[i]!, labelEvery: 1 },
      ],
    },
    hour: {
      projector: foldHourProjector,
      divisions: [
        { slots: 60, slotLabel: (i) => `:${p2(i)}`, labelEvery: 5 },
        { slots: 4, slotLabel: (i) => `:${p2(i * 15)}`, labelEvery: 1 },
      ],
    },
    // decimal upper folds: the calendar turns base-10 above the year
    decade: {
      projector: foldDecadeProjector,
      divisions: [{ slots: 10, slotLabel: (i) => `'${i}`, labelEvery: 1 }],
    },
    century: {
      projector: foldCenturyProjector,
      divisions: [{ slots: 10, slotLabel: (i) => `${i * 10}s`, labelEvery: 1 }],
    },
    millennium: {
      projector: foldMillenniumProjector,
      divisions: [{ slots: 10, slotLabel: (i) => `${i * 100}s`, labelEvery: 1 }],
    },
  };
  /** boundary prominence at an instant: the coarsest calendar unit that
   *  rolls over exactly there decides the separator weight (year > month >
   *  day > none) — so a month-fold grid shows 更醒目 lines between years,
   *  a day-fold between months, etc. */
  const boundaryStrength = (ms: number): number => {
    const a = new Date(ms - 1);
    const b = new Date(ms);
    if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return 0.42;
    if (a.getUTCFullYear() !== b.getUTCFullYear()) {
      const y = b.getUTCFullYear();
      if (y % 1000 === 0) return 1.0; // millennium boundary, 更醒目の最上段
      if (y % 100 === 0) return 0.95;
      if (y % 10 === 0) return 0.9;
      return 0.85;
    }
    if (a.getUTCMonth() !== b.getUTCMonth()) return 0.62;
    if (a.getUTCDate() !== b.getUTCDate()) return 0.5;
    return 0.34;
  };

  /** finest division whose columns stay ≥1rem within the content measure */
  const chooseDivision = (fv: (typeof FOLD_VIEWS)[Exclude<TimelineFold, "none">], contentW: number, rem: number): FoldDivision | null => {
    for (const d of fv.divisions) if (contentW / d.slots >= rem) return d;
    return null;
  };
  const foldView = () => FOLD_VIEWS[fold as Exclude<TimelineFold, "none">];
  /** label for any fold row, including empty ones (via the row's start instant) */
  const foldRowLabel = (rowIndex: number) => {
    const v = foldView();
    return v.projector.project(foldRowStartMs(fold, rowIndex))?.rowLabel ?? String(rowIndex);
  };
  /** folded glyph layout, shared by drawFolded and eventAt so hover matches
   *  pixels exactly: micro-lanes appear once rows are tall enough, else the
   *  row centerline. Returns null for unfoldable events. */
  const foldGlyphPos = (e: Ev, view: LaneView) => {
    const t = tMsOfEv(e);
    if (t == null) return null;
    const p = foldView().projector.project(t);
    if (!p) return null;
    const usableW = Math.max(40, view.width - FOLD_X0 - 8);
    const rowH = view.zoomY;
    const x = FOLD_X0 + p.phase0 * usableW;
    const rowTop = worldToScreenY(view, p.rowIndex - 0.5);
    if (rowH < 14) return { x, y: rowTop + rowH / 2, p, laneH: 0 };
    const cats = catMeta.filter((m) => m.cat !== "periodic" && enabled.has(m.cat));
    const lane = Math.max(0, cats.findIndex((m) => m.cat === e.cat));
    const laneH = (rowH - 4) / Math.max(1, cats.length);
    return { x, y: rowTop + 2 + lane * laneH + laneH / 2, p, laneH };
  };
  const FOLD_X0 = RULER_W + 8;
  const PULSE_MS = 2200;
  /** transient search-pulse marker (folded mode has no horizontal pan) */
  let pulse: { world: number; phase: number; until: number } | null = null;
  /** label rects placed by the last folded draw — labels are hover targets
   *  too, not just their dots (codex review) */
  let foldLabelRects: { x0: number; x1: number; y: number; e: Ev }[] = [];
  // ── OKLCH heat-cells: per-cell event density in the fold grid ─────────────
  // The track already spends HUE on identity, so within a track density is
  // pure magnitude: the track's hue with an OKLCH lightness ramp (sequential,
  // one hue, light→dark — CVD-safe because magnitude never rides on hue).
  // Counts bucket on a fixed log2 ladder (1,2,4,8,16+) so scrolling never
  // re-normalizes colors. Sparse cells (≤3) keep their dots; dense cells
  // suppress dots and label the count when the cell affords it.
  // (Conversion + ramp shared with the tree fold — treefold.ts owns them.)
  /** cell fill for `count` events in a category cell, per theme surface */
  const heatCellColor = (cat: Cat, count: number, darkTheme: boolean): string =>
    heatRampColor(colorOf(cat), count, darkTheme);
  // ── precision-aware LOD: point → interval → tint ──────────────────────────
  // An event whose precision window outgrows the view stops being a point:
  // ~a cell wide → interval (row fragments); beyond the viewport → tint
  // (no glyph; presence wash in the heat cells). Hysteresis 1.25/0.8 per
  // boundary so zoom jitter doesn't flap states (joint codex×claude design).
  type EvLod = "point" | "interval" | "tint";
  // hysteresis memory is keyed by (event, fold level): the SAME event can sit
  // at different levels in different tracks/frames on the symlog axis, and a
  // single-key map made states leak across levels (codex review P0). WeakMap
  // needs no growth valve — a mid-frame clear corrupted the frame (P1).
  const evLodPrev = new WeakMap<Ev, Map<string, EvLod>>();
  // classification uses NOMINAL periods, not exact projected pixels — a
  // documented v1 approximation of the projected-pixel classifier (calendar
  // rows vary, symlog is nonlinear); the hysteresis band absorbs the error.
  const classifyEv = (e: Ev, level: Exclude<TimelineFold, "none">, slots: number, bandPx: number, H: number): { lod: EvLod; win: readonly [number, number] | null } => {
    const win = e.precision?.kind === "calendar" ? precisionWindow(e) : null;
    if (!win) return { lod: "point", win: null }; // no window → today's behavior
    const windowRows = (win[1] - win[0]) / FOLD_PERIOD_MS[level]!;
    const slotFrac = windowRows * slots; // window width in slot units
    const visibleRows = Math.max(1, H / Math.max(1, bandPx));
    let mem = evLodPrev.get(e);
    if (!mem) evLodPrev.set(e, (mem = new Map()));
    const prev = mem.get(level) ?? "point";
    const up = 1.25;
    const down = 0.8;
    let lod: EvLod;
    if (windowRows > visibleRows * (prev === "tint" ? down : up)) lod = "tint";
    else if (slotFrac > (prev === "point" ? up : down)) lod = "interval";
    else lod = "point";
    mem.set(level, lod);
    // with heat cells disabled there is NO presence carrier: a tint event
    // would simply vanish (codex P0). The classification truth is stored
    // undegraded (hysteresis stays honest); the EFFECTIVE state every
    // consumer renders/hits with degrades tint → interval while heat is off.
    const eff: EvLod = !heatEnabled && lod === "tint" ? "interval" : lod;
    return { lod: eff, win };
  };
  /** visible fold-row range from PROJECTED screen endpoints — symlog rows
   *  vary in height, so center ± H/centerBand under-covers (codex review) */
  const visibleRowRange = (level: Exclude<TimelineFold, "none">, view: LaneView, H: number, fallbackRow: number): { r0: number; r1: number } => {
    const proj = FOLD_VIEWS[level].projector;
    const rowAt = (sy: number): number | null => {
      const t = tMsOfYbp(yBPof(screenToWorldY(view, sy)));
      if (!Number.isFinite(t)) return null;
      return proj.project(t)?.rowIndex ?? null;
    };
    const a = rowAt(HEADER_H - 40);
    const b = rowAt(H + 40);
    const r0 = Math.min(a ?? fallbackRow, b ?? fallbackRow);
    const r1 = Math.max(a ?? fallbackRow, b ?? fallbackRow);
    return { r0: r0 - 1, r1: r1 + 1 };
  };

  /** per-frame cell counts per track (cat → rowIndex*64+slot → n), shared by
   *  the grid pass (fills + labels) and the event pass (dot suppression) */
  const heatCells = new Map<Cat, { level: string; cells: Map<string, number>; ramp: Map<string, number>; presence: Map<string, number> }>();
  const HEAT_DOT_MAX = 3; // cells with more events than this drop their dots

  /** pseudo-x-axis specs queued by folding tracks for the sticky header */
  const foldHeaderAxes: { x0: number; contentW: number; div: FoldDivision; every: number }[] = [];

  // ── fold-switch morph-lite ────────────────────────────────────────────────
  // On a fold change, every event glyph glides from its OLD screen position to
  // its new one (~280ms, easeOutBack for a light spring feel) instead of
  // teleporting. Positions are captured from the outgoing projection+view;
  // targets are computed live each frame, so the glide composes with whatever
  // the viewport is doing.
  const FOLD_ANIM_MS = 280;
  let foldAnim: { from: Map<Ev, { x: number; y: number }>; t0: number } | null = null;
  const easeOutBack = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
  /** screen position of an event under the CURRENT mode (fold or continuous) */
  const glyphScreenPos = (e: Ev, view: LaneView): { x: number; y: number } | null => {
    if (fold !== "none") {
      const g = foldGlyphPos(e, view);
      return g ? { x: g.x, y: g.y } : null;
    }
    const tracks = activeTracks(view);
    const tr2 = tracks.find((t) => t.meta.cat === e.cat);
    if (!tr2) return null;
    return { x: tr2.x0 + tr2.w / 2, y: worldToScreenY(view, worldOf(e.y)) };
  };
  // ── per-track folding: fold whenever space allows (rg principle) ──────────
  // Inside a track, an event's cycle already occupies a y-band on the axis.
  // When that band renders ≥1rem tall AND the track is wide enough, the event
  // quantizes to the band's center and spreads by phase in x — no coordinate
  // switch, no global mode. On the symlog axis the fold level varies ALONG
  // the axis: recent (tall) bands fold fine, deep-time (thin) bands stay dots.
  let trackFold = true;
  let heatEnabled = true; // pref: heat cells + presence wash
  let glideEnabled = true; // pref: glide animation on level changes
  const TRACK_FOLD_MIN_W_REM = 20; // a track folds only when at least this wide
  const TRACK_FOLD_EXIT_W_REM = 17; // …and unfolds below this (width hysteresis)
  /** per-category fold latch for the width hysteresis band */
  const trackFoldLatch = new Map<Cat, boolean>();
  const trackWideEnough = (cat: Cat, w: number, rem: number) => {
    const was = trackFoldLatch.get(cat) ?? false;
    const on = w >= (was ? TRACK_FOLD_EXIT_W_REM : TRACK_FOLD_MIN_W_REM) * rem;
    trackFoldLatch.set(cat, on);
    return on;
  };
  /** per-event glide: when an event's fold level (or rail↔fold) changes, it
   *  glides from its last drawn position to the new one — taku's transition
   *  animation, applied per element instead of per mode switch */
  const GLIDE_MS = 280;
  const glide = new Map<Ev, { x: number; y: number; key: string; from?: { x: number; y: number; t0: number } }>();
  const glidePos = (e: Ev, key: string, tx: number, ty: number): { x: number; y: number; moving: boolean } => {
    if (!glideEnabled) return { x: tx, y: ty, moving: false };
    const prev = glide.get(e);
    let from = prev?.from;
    if (prev && prev.key !== key) from = { x: prev.x, y: prev.y, t0: performance.now() };
    let x = tx;
    let y = ty;
    let moving = false;
    if (from) {
      const t = (performance.now() - from.t0) / GLIDE_MS;
      if (t < 1) {
        const k = easeOutBack(Math.max(0, t));
        x = from.x + (tx - from.x) * k;
        y = from.y + (ty - from.y) * k;
        moving = true;
      } else {
        from = undefined;
      }
    }
    glide.set(e, { x, y, key, from });
    if (glide.size > 1200) glide.clear(); // safety valve
    return { x, y, moving };
  };
  const TRACK_FOLD_MAX_CONTENT_REM = 45; // content measure capped like a text column
  const remPx = () =>
    typeof document !== "undefined"
      ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      : 16;
  const LADDER_FINE_FIRST = ["hour", "day", "week", "month", "year", "decade", "century", "millennium"] as const;
  /** slim y-axis gutter inside a folding track: row labels live here,
   *  uncovered by phase-0 events */
  const Y_GUTTER_REM = 2.6;
  const trackContentX0 = (x0: number, rem: number) => x0 + Y_GUTTER_REM * rem;
  const trackContentW = (w: number, rem: number) =>
    Math.min(w - Y_GUTTER_REM * rem - 8, TRACK_FOLD_MAX_CONTENT_REM * rem);
  /** folded position of a dated event inside its track, or null (classic rail).
   *  Picks the FINEST fold level whose local cycle band is ≥1rem tall and
   *  whose phase slots are ≥1rem wide within the track's content measure. */
  const trackFoldPos = (e: Ev, view: LaneView, x0: number, w: number) => {
    if (!trackFold || fold !== "none") return null;
    const rem = remPx();
    if (!trackWideEnough(e.cat, w, rem)) return null;
    const t = tMsOfEv(e);
    if (t == null) return null;
    const contentW = trackContentW(w, rem);
    for (const lf of LADDER_FINE_FIRST) {
      const fv = FOLD_VIEWS[lf];
      const div = chooseDivision(fv, contentW, rem);
      if (!div) continue; // no division's columns readable → coarser level
      const p = fv.projector.project(t);
      if (!p) continue;
      const start = foldRowStartMs(lf, p.rowIndex);
      const end = foldRowStartMs(lf, p.rowIndex + 1);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const yTop = worldToScreenY(view, worldOf(ybpOfTMs(start)));
      const yBot = worldToScreenY(view, worldOf(ybpOfTMs(end)));
      if (Math.abs(yBot - yTop) < rem) continue; // band unreadable → coarser
      return {
        x: trackContentX0(x0, rem) + p.phase0 * contentW,
        y: (yTop + yBot) / 2,
        level: lf,
        bandPx: Math.abs(yBot - yTop),
        row: p.rowIndex,
        slot: Math.floor(Math.min(0.999999, p.phase0) * div.slots),
        slots: div.slots, // the CHOSEN division's slot count (may be fractional)
      };
    }
    return null;
  };

  const captureGlyphs = (view: LaneView) => {
    const from = new Map<Ev, { x: number; y: number }>();
    let n = 0;
    for (const e of points) {
      if (!enabled.has(e.cat) || tMsOfEv(e) == null) continue;
      const p = glyphScreenPos(e, view);
      if (!p || p.y < -50 || p.y > view.height + 50) continue;
      from.set(e, p);
      if (++n >= 400) break; // cap the animated population
    }
    return from;
  };

  function drawFolded(ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv) {
    const { theme } = env;
    const W = view.width;
    const H = view.height;
    const usableW = Math.max(40, W - FOLD_X0 - 8);
    const rowH = view.zoomY; // one row = 1.0 world unit = one fold period
    const fv0 = foldView();
    const fv = { ...fv0, ...fv0.divisions[0]! }; // legacy path: finest division
    const yearTop = Math.floor(screenToWorldY(view, 0) + 0.5);
    const yearBot = Math.ceil(screenToWorldY(view, H) + 0.5);
    const phaseX = (p: number) => FOLD_X0 + p * usableW;
    const rowTopY = (year: number) => worldToScreenY(view, year - 0.5);

    // row bands + year labels + per-year month gridlines
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let year = yearTop; year <= yearBot; year++) {
      const y0 = rowTopY(year);
      if (year % 2 === 0) {
        ctx.fillStyle = withAlpha(theme.textFaint, 0.05);
        ctx.fillRect(FOLD_X0, y0, usableW, rowH);
      }
      ctx.strokeStyle = withAlpha(theme.textFaint, 0.22);
      ctx.beginPath();
      ctx.moveTo(FOLD_X0, y0 + 0.5);
      ctx.lineTo(W - 8, y0 + 0.5);
      ctx.stroke();
      // row label in the left ruler, readable even for thin rows
      if (rowH >= 9) {
        ctx.fillStyle = theme.textFaint;
        ctx.textAlign = "right";
        ctx.fillText(foldRowLabel(year), RULER_W - 2, y0 + rowH / 2);
      }
    }

    // equal-width slot grid: boundaries sit at exactly i/slots in EVERY row
    // (max-slot phases), so the guides are single full-height lines — the
    // same wall time aligns across rows at every fold level
    for (let m = 1; m < fv.slots; m++) {
      const major = m % fv.labelEvery === 0;
      if (!major && fv.slots > 32) continue; // 60-slot folds: majors only
      ctx.strokeStyle = withAlpha(theme.textFaint, major ? 0.12 : 0.06);
      const x = phaseX(m / fv.slots);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }

    // "now" marker: a tick at today's phase in the current row
    const nowP = fv.projector.project(PRESENT_EPOCH * 1000);
    if (nowP && nowP.rowIndex >= yearTop && nowP.rowIndex <= yearBot) {
      const x = phaseX(nowP.phase0);
      const y0 = rowTopY(nowP.rowIndex);
      ctx.strokeStyle = withAlpha(theme.accent, 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y0 + 1);
      ctx.lineTo(x, y0 + rowH - 1);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // events — LOD ladder by row height: dots → micro-lane dots → labels;
    // positions come from foldGlyphPos, the SAME helper eventAt hit-tests.
    // During a fold-switch morph, each glyph glides old→new (easeOutBack);
    // labels wait until the motion ends so text doesn't smear mid-flight.
    let animK = 1;
    if (foldAnim) {
      const t = (performance.now() - foldAnim.t0) / FOLD_ANIM_MS;
      if (t >= 1) foldAnim = null;
      else {
        animK = easeOutBack(Math.max(0, t));
        onUpdate(); // keep animating
      }
    }
    ctx.textAlign = "left";
    const darkG = srgbToOklch(theme.background as string).L < 0.5;
    const labelCandidates: { e: Ev; x: number; y: number; r: number }[] = [];
    for (const e of points) {
      if (!enabled.has(e.cat)) continue;
      const g = foldGlyphPos(e, view);
      if (!g || g.p.rowIndex < yearTop - 1 || g.p.rowIndex > yearBot + 1) continue;
      const color = colorOf(e.cat);
      let gx = g.x;
      let gy = g.y;
      if (foldAnim) {
        const from = foldAnim.from.get(e);
        if (from) {
          gx = from.x + (g.x - from.x) * animK;
          gy = from.y + (g.y - from.y) * animK;
        }
      }
      const mb = massBucket(e.mass);
      if (rowH < 14) {
        // collapsed row: density dots on the row centerline — known mass
        // widens the tick a step per rung so big commits stay visible
        ctx.fillStyle = withAlpha(color, 0.85);
        ctx.fillRect(gx - 1 - mb * 0.5, gy - 1, 2 + mb, 2);
        continue;
      }
      const r = Math.min(3.2 + mb * 0.6, Math.max(1.5, g.laneH * 0.3 + mb * 0.5));
      const fillC = mb ? massGlyph(e, darkG).fill : color;
      ctx.fillStyle = foldAnim && !foldAnim.from.has(e) ? withAlpha(fillC, Math.min(1, animK)) : fillC;
      ctx.beginPath();
      ctx.arc(gx, gy, r, 0, Math.PI * 2);
      ctx.fill();
      if (!foldAnim && g.laneH >= 11) labelCandidates.push({ e, x: g.x, y: g.y, r });
    }
    // greedy label declutter: important events label first; later (lesser)
    // labels are dropped when they'd overlap an already-placed one on the
    // same text line — dense ingest clusters degrade to dots, not soup
    labelCandidates.sort((a, b) => b.e.imp - a.e.imp);
    const placed: { x0: number; x1: number; y: number; e: Ev }[] = [];
    for (const c of labelCandidates) {
      const text = fit(ctx, tr(c.e.label), W - 8 - c.x - 6);
      if (!text) continue;
      const x0 = c.x + c.r + 3;
      const x1 = x0 + ctx.measureText(text).width + 6;
      if (placed.some((p) => Math.abs(p.y - c.y) < 11 && x0 < p.x1 && x1 > p.x0)) continue;
      placed.push({ x0, x1, y: c.y, e: c.e });
      ctx.fillStyle = withAlpha(theme.text, 0.92);
      ctx.fillText(text, x0, c.y);
    }
    foldLabelRects = placed;

    // search pulse: expanding ring at the found (row, phase)
    if (pulse) {
      const life = pulse.until - performance.now();
      if (life <= 0) pulse = null;
      else {
        const k = 1 - life / PULSE_MS;
        const x = phaseX(pulse.phase);
        const y = worldToScreenY(view, pulse.world);
        ctx.strokeStyle = withAlpha(theme.accent, 0.85 * (1 - k));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 6 + k * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        onUpdate(); // keep animating until expiry
      }
    }

    // sticky header: month phase labels (reference year — exact per-row lines
    // above carry the per-year truth; the header is a guide)
    ctx.fillStyle = withAlpha(theme.background, 0.82);
    ctx.fillRect(FOLD_X0, 0, W - FOLD_X0, HEADER_H);
    ctx.strokeStyle = withAlpha(theme.textFaint, 0.2);
    ctx.beginPath();
    ctx.moveTo(FOLD_X0, HEADER_H + 0.5);
    ctx.lineTo(W, HEADER_H + 0.5);
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    // cull header labels on narrow canvases: widen the label stride until
    // neighbouring labels keep a readable gap (codex review: 60-slot hour
    // fold could space its labels ~3px apart at min width)
    let every = fv.labelEvery;
    while ((usableW / fv.slots) * every < 34 && every < fv.slots) every *= 2;
    for (let m = 0; m < fv.slots; m += every) {
      const x = phaseX(m / fv.slots);
      ctx.fillStyle = theme.textFaint;
      ctx.fillText(tr(fv.slotLabel(m)), x + 3, HEADER_H / 2);
    }
    ctx.fillStyle = theme.textFaint;
    ctx.textAlign = "right";
    ctx.fillText(tr(fold), RULER_W - 2, HEADER_H / 2);
    ctx.textAlign = "left";
  }

  return {
    title: ds?.title ?? "deep time",
    categories: catMeta,
    isEnabled: (cat) => enabled.has(cat),
    setEnabled(cat, on) {
      on ? enabled.add(cat) : enabled.delete(cat);
    },
    setOnUpdate(fn) {
      onUpdate = fn;
    },
    strings() {
      const s = new Set<string>();
      for (const e of points) {
        s.add(e.label);
        if (e.detail) s.add(e.detail);
      }
      for (const m of catMeta) s.add(m.label);
      for (const era of eras) s.add(era.label);
      for (const c of cycles) s.add(c.label);
      return [...s];
    },
    setTranslate(fn) {
      tr = fn;
      onUpdate();
    },
    isLogAxis: () => logAxis,
    setLogAxis(on) {
      logAxis = on;
      onUpdate();
    },
    eventCount: () => points.length,
    eventAt(sx, sy, view) {
      // a visible label is a hover target for its event (either mode)
      for (const l of foldLabelRects) {
        if (sx >= l.x0 && sx <= l.x1 && Math.abs(sy - l.y) <= 7) {
          const title = l.e.label.replace(/\s+born$/, "").replace(/\s*·.*$/, "").trim();
          return { title, detail: l.e.detail, cat: l.e.cat };
        }
      }
      if (fold !== "none") {
        let best: Ev | null = null;
        let bestD = 9;
        for (const e of points) {
          if (!enabled.has(e.cat)) continue;
          const g = foldGlyphPos(e, view);
          if (!g) continue;
          const d = Math.hypot(g.x - sx, g.y - sy);
          if (d < bestD) {
            bestD = d;
            best = e;
          }
        }
        if (!best) return null;
        const title = best.label.replace(/\s+born$/, "").replace(/\s*·.*$/, "").trim();
        return { title, detail: best.detail, cat: best.cat };
      }
      // the event in the hovered track nearest the cursor — folded events sit
      // at trackFoldPos (the same helper the draw uses), rail events on the y
      const tracks = activeTracks(view);
      const track = tracks.find((t) => sx >= t.x0 && sx < t.x0 + t.w);
      if (!track || track.meta.cat === "periodic") return null;
      let best: Ev | null = null;
      let bestDy = 11;
      for (const e of points) {
        if (e.cat !== track.meta.cat) continue;
        const fp = trackFoldPos(e, view, track.x0, track.w);
        // tint-state events have NO visible glyph — giving the invisible
        // nominal point hover semantics would fake precision (cell-level
        // candidate listing is the deferred v1 follow-up)
        if (fp && classifyEv(e, fp.level, fp.slots, fp.bandPx, view.height).lod === "tint") continue;
        const dy = fp
          ? Math.hypot(fp.x - sx, fp.y - sy)
          : Math.abs(worldToScreenY(view, worldOf(e.y)) - sy);
        if (dy < bestDy) {
          bestDy = dy;
          best = e;
        }
      }
      if (!best) return null;
      const title = best.label.replace(/\s+born$/, "").replace(/\s*·.*$/, "").trim();
      return { title, detail: best.detail, cat: best.cat };
    },
    find(query, limit = 7) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const hits: Array<{ e: Ev; rank: number }> = [];
      for (const e of points) {
        if (!enabled.has(e.cat)) continue;
        const label = e.label.toLowerCase();
        const inLabel = label.includes(q);
        if (!inLabel && !e.detail?.toLowerCase().includes(q)) continue;
        // rank: label-start > label-contains > detail; then importance
        const rank =
          (label.startsWith(q) ? 2 : inLabel ? 1 : 0) + e.imp;
        hits.push({ e, rank });
      }
      hits.sort((a, b) => b.rank - a.rank);
      if (fold !== "none") {
        // folded hits focus their row; the phase drives the pulse highlight
        // (the lane cannot pan horizontally). Undatable hits fall back to
        // their row-less continuous position — skip them in fold mode.
        return hits
          .flatMap(({ e }) => {
            const t = tMsOfEv(e);
            const p = t == null ? null : foldView().projector.project(t);
            if (!p) return [];
            return [{
              label: e.label,
              detail: e.detail,
              cat: e.cat,
              color: colorOf(e.cat),
              center: p.rowIndex,
              scale: 1.6,
              phase: p.phase0,
            }];
          })
          .slice(0, limit);
      }
      return hits.slice(0, limit).map(({ e }) => ({
        label: e.label,
        detail: e.detail,
        cat: e.cat,
        color: colorOf(e.cat),
        center: worldOf(e.y),
        scale: ctxWorld(e),
      }));
    },
    extent: () => {
      if (fold !== "none") {
        const r = foldRows();
        return { min: r.min - 0.5, max: r.max + 0.5 };
      }
      return {
        min: worldOf(OLDEST) * 1.01,
        max: worldOf(-FUT_HORIZON) * 1.01,
      };
    },
    // bias the initial fit toward the PAST: frame Big Bang→now plus a thin
    // future sliver; the sparse far future stays reachable by scrolling
    fitExtent: () => {
      if (fold !== "none") {
        const r = foldRows();
        return { min: r.min - 0.5, max: r.max + 0.5 };
      }
      if (ds?.fitYBP) {
        // dataset-biased opening frame (axis-aware via worldOf)
        return { min: worldOf(ds.fitYBP.top), max: worldOf(ds.fitYBP.bot) };
      }
      return {
        min: worldOf(OLDEST) * 1.01,
        max: logAxis ? 2.5 : 0,
      };
    },
    get maxZoom() {
      return adaptiveMaxZoom();
    },
    // viewport emptiness (target-density): 1 when a void, 0 once ≥ TARGET
    // in-scale events are on screen — drives scroll-into-void auto-zoom-out
    emptiness: (view) => {
      if (fold !== "none") return 0;
      const TARGET = 5;
      const top = screenToWorldY(view, 0);
      const bot = screenToWorldY(view, view.height);
      const vspan = view.height / view.zoomY;
      let n = 0;
      for (const e of points) {
        if (!enabled.has(e.cat) || influenceOf(e) < vspan) continue;
        const wy = worldOf(e.y);
        if (wy >= top && wy <= bot) n++;
      }
      return Math.max(0, 1 - n / TARGET);
    },
    // double-click an event → center it and zoom to ~its precision scale
    focusAt: (screenY, view) => {
      if (fold !== "none") {
        const year = Math.round(screenToWorldY(view, screenY));
        return { center: year, zoom: view.height / 1.6 };
      }
      let best: Ev | null = null;
      let bestD = 30;
      for (const e of points) {
        if (!enabled.has(e.cat)) continue;
        const d = Math.abs(worldToScreenY(view, worldOf(e.y)) - screenY);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      if (!best) return null;
      return { center: worldOf(best.y), zoom: view.height / ctxWorld(best) };
    },
    // the zoom anchor gravitates to nearby enabled events (and the now line);
    // each carries its track-centre x so the snap is track-aware
    snapTargets: (view) => {
      // fold mode: no zoom-center snapping — rows are a uniform lattice, and
      // snap gravity just fights the user's own anchor (taku 2026-07-12)
      if (fold !== "none") return [];
      const tracks = activeTracks(view);
      const cx = new Map(tracks.map((t) => [t.meta.cat, t.x0 + t.w / 2]));
      const top = screenToWorldY(view, -40);
      const bot = screenToWorldY(view, view.height + 40);
      const out: { y: number; x?: number }[] = [{ y: 0 }]; // now line: any x
      for (const e of points) {
        if (!enabled.has(e.cat) || e.imp < 0.45) continue;
        const wy = worldOf(e.y);
        if (wy >= top && wy <= bot) out.push({ y: wy, x: cx.get(e.cat) });
      }
      return out;
    },
    draw: (ctx, view, env) =>
      fold === "none" ? draw(ctx, view, env) : drawFolded(ctx, view, env),
    getFold: () => fold,
    setFold(f, opts) {
      if (f === fold) return;
      // capture outgoing glyph positions BEFORE the projection changes
      foldAnim = opts?.animateFrom
        ? { from: captureGlyphs(opts.animateFrom), t0: performance.now() }
        : null;
      fold = f;
      pulse = null;
      onUpdate();
    },
    tMsForWorld(worldY) {
      const t =
        fold !== "none"
          ? // mid-row representative instant (row start + half the period)
            foldRowStartMs(fold, Math.round(worldY)) + FOLD_PERIOD_MS[fold]! / 2
          : tMsOfYbp(yBPof(worldY));
      // TimeClip: deep-time worlds (Big Bang framing) exceed Date range —
      // report "no calendar instant here" instead of a poisoned number
      return Number.isFinite(t) && Number.isFinite(new Date(t).getTime()) ? t : null;
    },
    worldForTMs(tMs) {
      // TimeClip at entry: garbage in must not poison scrollY with NaN
      const clipped = Number.isFinite(tMs) ? new Date(tMs).getTime() : NaN;
      if (!Number.isFinite(clipped))
        return fold !== "none"
          ? (foldView().projector.project(PRESENT_EPOCH * 1000)?.rowIndex ?? 0)
          : worldOf(0);
      if (fold !== "none") {
        const proj = foldView().projector;
        const p = proj.project(clipped);
        // out-of-fold instant: land on the present row, never NaN
        return p?.rowIndex ?? proj.project(PRESENT_EPOCH * 1000)?.rowIndex ?? 0;
      }
      return worldOf(ybpOfTMs(clipped));
    },
    foldRowRange: () => foldRows(),
    isTrackFold: () => trackFold,
    setTrackFold(on) {
      trackFold = on;
      onUpdate();
    },
    setHeatCells(on) {
      heatEnabled = on;
      onUpdate();
    },
    setGlide(on) {
      glideEnabled = on;
      if (!on) glide.clear(); // stale origins would animate on re-enable
    },
    setPulse(hit) {
      if (fold === "none" || hit.phase === undefined) return;
      pulse = { world: hit.center, phase: hit.phase, until: performance.now() + PULSE_MS };
      onUpdate();
    },
    hudLine: (view, pointerY) => {
      const screenY = pointerY ?? view.height / 2;
      const cursorWorld = screenToWorldY(view, screenY);
      let tMs: number;
      if (fold !== "none") {
        // Only global fold mode changes the y coordinate system. Per-track
        // folds keep fold="none", so they correctly use the continuous-axis
        // inverse below. Global rows are centered on integer world coords;
        // interpolate exact UTC row boundaries so cursor time stays continuous.
        const row = Math.floor(cursorWorld + 0.5);
        const phase = Math.max(0, Math.min(1, cursorWorld - (row - 0.5)));
        const start = foldRowStartMs(fold, row);
        const end = foldRowStartMs(fold, row + 1);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          return `fold: ${fold} · ${foldRowLabel(row)}`;
        }
        tMs = start + (end - start) * phase;
      } else {
        tMs = tMsOfYbp(yBPof(cursorWorld));
      }
      const clipped = new Date(tMs).getTime();
      if (Number.isFinite(tMs) && Number.isFinite(clipped)) {
        // ISO communicates the calendar instant; fractional unix_ms preserves
        // the continuous y-derived value beyond Date's millisecond display.
        return `${new Date(clipped).toISOString()} · unix_ms ${tMs.toFixed(6)}`;
      }
      const yBP = yBPof(cursorWorld);
      if (yBP > OLDEST) return "before time";
      if (yBP < 0) return `in ${fmtDur(-yBP)}`; // future
      if (yBP >= 1e6) return fmtLabel(yBP, 1e6);
      if (yBP >= 1) return fmtLabel(yBP, 1);
      return fmtLabel(yBP, SEC);
    },
  };
}
