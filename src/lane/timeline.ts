/**
 * rgui lane source — deep time (Big Bang → far future), the widest 1-D zoom.
 *
 * One lane spanning ~13.8 billion years of past and ~10 billion of predicted
 * future — roughly 25 orders of magnitude once you reach dated releases. The
 * world axis is LINEAR "years before present": now ≈ 0, the Big Bang at −13.8e9
 * (top), the far future below. Keeping *now* at 0 is what lets a linear axis
 * work without a log scale — float precision is highest near 0, exactly where
 * the finest events (dated releases, eclipses) live, while the coarse ends need
 * no sub-year precision anyway.
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
import { screenToWorldY, worldToScreenY, type LaneView } from "./view.js";

/** "now" — present reference (Unix seconds, ~2026-07). */
const PRESENT_EPOCH = 1783512000;
const PRESENT_YEAR = 2026;
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

type Cat = "cosmic" | "bio" | "human" | "tech" | "repo" | "future" | "periodic";

interface CatMeta {
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
}

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
const INFLUENCE_BASE = 5.5e10; // > full extent, so imp≈1 is always labelled
const INFLUENCE_DOTS = 12; // dots linger this many × past the label cutoff
function influenceOf(e: Ev): number {
  return e.influence ?? INFLUENCE_BASE * Math.pow(e.imp, 4);
}

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
  { y: ymd(1991, 8, 25), label: "Linus announces Linux", imp: 0.68, cat: "repo", detail: '"just a hobby"' },
  { y: ymd(1991, 9, 17), label: "Linux 0.01", imp: 0.6, cat: "repo" },
  { y: ymd(1992, 1, 5), label: "Linux 0.12 — GPL", imp: 0.55, cat: "repo" },
  { y: ymd(1994, 3, 14), label: "Linux 1.0", imp: 0.62, cat: "repo" },
  { y: ymd(1996, 6, 9), label: "Linux 2.0 — SMP", imp: 0.55, cat: "repo" },
  { y: ymd(1999, 1, 26), label: "Linux 2.2", imp: 0.45, cat: "repo" },
  { y: ymd(2001, 1, 4), label: "Linux 2.4", imp: 0.48, cat: "repo" },
  { y: ymd(2003, 12, 17), label: "Linux 2.6", imp: 0.5, cat: "repo" },
  { y: ymd(2005, 4, 7), label: "Git created", imp: 0.66, cat: "repo", detail: "for kernel dev" },
  { y: ymd(2011, 7, 21), label: "Linux 3.0", imp: 0.52, cat: "repo" },
  { y: ymd(2015, 4, 12), label: "Linux 4.0", imp: 0.5, cat: "repo" },
  { y: ymd(2019, 3, 3), label: "Linux 5.0", imp: 0.5, cat: "repo" },
  { y: ymd(2022, 10, 2), label: "Linux 6.0", imp: 0.52, cat: "repo" },
  { y: ymd(2024, 11, 17), label: "Linux 6.12 LTS", imp: 0.48, cat: "repo" },
];

// tech & culture across world civilizations (yBP = 2026 − CE year; +BCE)
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
  { label: "Saros (eclipses)", period: 18.03, color: "#7dd3fc" },
  { label: "Solar cycle", period: 11, color: "#fbbf24" },
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
}

export interface TimelineSource extends LaneSource {
  readonly categories: readonly CatMeta[];
  isEnabled(cat: Cat): boolean;
  setEnabled(cat: Cat, on: boolean): void;
  /** substring search over event labels/details, ranked by importance */
  find(query: string, limit?: number): SearchHit[];
}

export function createTimelineSource(): TimelineSource {
  const points: Ev[] = [
    ...EVENTS, ...LINUX, ...CIV, ...LANGS, ...BORN, ...FUTURE,
  ].sort((a, b) => b.y - a.y);
  const byCat = new Map<Cat, Ev[]>();
  for (const e of points) (byCat.get(e.cat) ?? byCat.set(e.cat, []).get(e.cat)!).push(e);

  const enabled = new Set<Cat>(CAT_META.map((m) => m.cat));
  const worldOf = (yBP: number) => -yBP;

  // A track's "demand" = proximity-weighted importance mass of its events:
  // near/on-screen important events pull hard, distant ones fade (exp falloff).
  function trackDemand(cat: Cat, view: LaneView): number {
    if (cat === "periodic") {
      let c = 0;
      for (const cy of CYCLES) {
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
    const active = CAT_META.filter((m) => enabled.has(m.cat));
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
      else drawTrackEvents(ctx, view, theme, t.x0, t.w, H, topW, botW, t.meta.cat);
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
      ctx.fillText(fit(ctx, t.meta.label, t.w - 8), t.x0 + 6, HEADER_H / 2);
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
    let step = STEPS[0]!;
    for (const s of STEPS) {
      if (s * view.zoomY >= 66) step = s;
      else break;
    }
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
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
    for (const era of ERAS) {
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
        ctx.fillText(
          ctx.measureText(era.label).width < b - a - 8 ? era.label : "",
          0,
          0,
        );
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
    const color = CAT_COLOR[cat];
    const vis: Array<{ e: Ev; sy: number }> = [];
    for (const e of list) {
      const wy = worldOf(e.y);
      if (wy < topW || wy > botW) continue;
      vis.push({ e, sy: worldToScreenY(view, wy) });
    }
    vis.sort((a, b) => b.e.imp - a.e.imp);
    const placed: number[] = [];
    const cx = x0 + 7;
    const vspan = view.height / view.zoomY; // visible time-span (world years)
    ctx.textBaseline = "middle";
    for (const { e, sy } of vis) {
      if (sy < HEADER_H - 2 || sy > H + 2) continue;
      const infl = influenceOf(e);
      if (vspan > infl * INFLUENCE_DOTS) continue; // out of influence → hidden
      const future = e.cat === "future";
      const inScale = vspan <= infl; // zoomed in enough to earn a label
      const labeled =
        inScale && !placed.some((p) => Math.abs(p - sy) < LABEL_GAP);
      if (!labeled) {
        // presence hint: a small dim dot so hidden events aren't invisible
        ctx.beginPath();
        ctx.arc(cx, sy, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(color, 0.5);
        ctx.fill();
        continue;
      }
      placed.push(sy);
      const span = spanOf(e);
      if (span > 0 && span * view.zoomY * 2 >= 10) {
        // fuzzy time → soft uncertainty band (a blurred interval) + nominal line
        const yTop = worldToScreenY(view, worldOf(e.y + span));
        const yBot = worldToScreenY(view, worldOf(e.y - span));
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
        ctx.beginPath();
        ctx.arc(cx, sy, 3, 0, Math.PI * 2);
        if (future) {
          ctx.strokeStyle = color; // hollow dot marks a prediction
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.lineWidth = 1;
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = future ? theme.textDim : theme.text;
      ctx.fillText(fit(ctx, e.label, w - 18), cx + 8, sy);
      // detail on a second line when the track has spare vertical room
      if (e.detail) {
        const nextGap = placed.every((p) => p === sy || Math.abs(p - sy) > 26);
        if (nextGap) {
          ctx.font = "9px ui-monospace, Menlo, monospace";
          ctx.fillStyle = theme.textMuted;
          ctx.fillText(fit(ctx, e.detail, w - 18), cx + 8, sy + 11);
        }
      }
    }
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
    // a cycle is "active" when its period is resolvable at this zoom
    const active = CYCLES.filter((c) => {
      const px = c.period * view.zoomY;
      return px >= 9 && px <= H * 1.6;
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
      const fromW = worldOf(c.from ?? BIG_BANG);
      const toW = worldOf(c.to ?? 0);
      const lo = Math.max(topW, fromW);
      const hi = Math.min(botW, toW);
      ctx.strokeStyle = withAlpha(c.color, 0.7);
      ctx.lineWidth = 1;
      let n = 0;
      const first = Math.ceil(lo / c.period);
      const last = Math.floor(hi / c.period);
      for (let k = first; k <= last && n < 240; k++, n++) {
        const sy = worldToScreenY(view, k * c.period);
        if (sy < HEADER_H || sy > H) continue;
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
      ctx.fillText(`${c.label} · ${fmtDur(c.period)}`, 0, 0);
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
      const dist = above ? fmtDur(topW - worldOf(above.y)) : "";
      badge(ctx, theme, cx, HEADER_H + 12, "▲", above?.label, dist, aboveN);
    }
    if (belowN) {
      const dist = below ? fmtDur(worldOf(below.y) - botW) : "";
      badge(ctx, theme, cx, H - 12, "▼", below?.label, dist, belowN);
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

  return {
    title: "deep time",
    categories: CAT_META,
    isEnabled: (cat) => enabled.has(cat),
    setEnabled(cat, on) {
      on ? enabled.add(cat) : enabled.delete(cat);
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
      return hits.slice(0, limit).map(({ e }) => ({
        label: e.label,
        detail: e.detail,
        cat: e.cat,
        color: CAT_COLOR[e.cat],
        center: worldOf(e.y),
        scale: Math.max(spanOf(e) * 30, 1e-9),
      }));
    },
    extent: () => ({ min: worldOf(BIG_BANG) * 1.005, max: FUTURE_HORIZON * 1.02 }),
    maxZoom: 5e6,
    // viewport emptiness (target-density): 1 when a void, 0 once ≥ TARGET
    // in-scale events are on screen — drives scroll-into-void auto-zoom-out
    emptiness: (view) => {
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
      const ctxWindow = Math.max(spanOf(best) * 30, 1e-9); // ~its own scale
      return { center: worldOf(best.y), zoom: view.height / ctxWindow };
    },
    // the zoom anchor gravitates to nearby enabled events (and the now line);
    // each carries its track-centre x so the snap is track-aware
    snapTargets: (view) => {
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
    draw,
    hudLine: (view) => {
      const yBP = -screenToWorldY(view, view.height / 2);
      if (yBP > BIG_BANG) return "before time";
      if (yBP < 0) return `in ${fmtDur(-yBP)}`; // future
      if (yBP >= 1e6) return fmtLabel(yBP, 1e6);
      if (yBP >= 1) return fmtLabel(yBP, 1);
      return fmtLabel(yBP, SEC);
    },
  };
}
