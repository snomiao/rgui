/**
 * rgui calendar demo — a calendar where ZOOM replaces view switching.
 *
 * One lane on the linear time axis: the per-track fold ladder renders year ⇄
 * month ⇄ week ⇄ day continuously — pinch or wheel is the navigation. All
 * calendars overlay in ONE grid (mobile-first), tinted per source calendar
 * via the engine's per-event color override; chips toggle calendars through
 * the replace-the-source pattern.
 *
 * Input grammar, split by POINTER TYPE (taku spec):
 *   mouse / pen  left-drag  → select the event span (Google-Calendar style);
 *                             the viewport pans with wheel / keys / pinch
 *   touch finger drag/flick → pan (navigation stays cheapest on phones)
 *   tap / click empty slot  → 30-min placeholder
 *   tap / click an event    → detail panel (rename / delete)
 * The placeholder is pure UI STATE (resizable via its handles, nothing saved)
 * until the create panel's save; the panel floats next to the grid when
 * there's room and snaps to the bottom on phones.
 *
 * The display TIME ZONE is a preference (⚙ → searchable IANA list). The fold
 * projectors are UTC-based, so the demo presents timestamps to the engine in
 * a SHIFTED frame — wall time in the chosen zone reads as UTC — which makes
 * day rows break at that zone's midnight. All-day events stay unshifted
 * (their date is zone-free and already sits on the UTC day boundary).
 */
import { parseIcs, serializeIcs, zoneOffsetMs, type IcsEvent } from "./calendar/ics.js";
import { createLane } from "./lane/lane.js";
import {
  createTimelineSource,
  type TimelineEvent,
  type TimelineSource,
} from "./lane/timeline.js";
import { screenToWorldY } from "./lane/view.js";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;

// ── preferences ───────────────────────────────────────────────────────────
const PREFS_KEY = "rgui-calendar-prefs";
const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const prefs: { tz?: string; theme: "auto" | "light" | "dark" } = { theme: "auto" };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"));
} catch { /* defaults */ }
function persistPrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    localStorage.setItem("rgui-theme-mode", prefs.theme);
  } catch { /* private mode */ }
}

// ── theme: auto follows the OS, and follows OS CHANGES live ───────────────
const osLight = matchMedia("(prefers-color-scheme: light)");
const resolveTheme = (): "light" | "dark" =>
  prefs.theme === "auto" ? (osLight.matches ? "light" : "dark") : prefs.theme;
function applyTheme() {
  const t = resolveTheme();
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("rgui-theme", t); } catch { /* other pages read this */ }
  lane?.setTheme(t);
  themeSel.value = prefs.theme;
}
osLight.addEventListener("change", () => {
  if (prefs.theme === "auto") applyTheme();
});

// ── time zone shift frame ─────────────────────────────────────────────────
let tz = prefs.tz ?? systemTz;
const offAt = (ms: number): number => {
  try {
    return zoneOffsetMs(ms, tz);
  } catch {
    return zoneOffsetMs(ms, (tz = systemTz));
  }
};
const toShifted = (ms: number) => ms + offAt(ms);
const fromShifted = (s: number) => {
  let real = s - offAt(s);
  real = s - offAt(real); // refine once across DST edges
  return real;
};

let fmt!: Intl.DateTimeFormat;
let fmtDay!: Intl.DateTimeFormat;
function makeFormatters() {
  fmt = new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: tz,
  });
  // all-day dates are zone-free — format their UTC calendar date as-is
  fmtDay = new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}
makeFormatters();

// ── model ─────────────────────────────────────────────────────────────────
interface CalMeta {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
}
type CalEvent = IcsEvent & { calId: string };

const PALETTE = ["#60a5fa", "#f3820d", "#2dd4bf", "#f472b6", "#ffd21c", "#b25ce0", "#7dd3fc"];
const MINE = "mine";

let calendars: CalMeta[] = [];
let events: CalEvent[] = [];

const STORE_KEY = "rgui-calendar";
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ calendars, events }));
  } catch { /* quota — session-only */ }
}
try {
  const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
  if (s?.calendars && s?.events) {
    calendars = s.calendars;
    events = s.events;
  }
} catch { /* corrupted store → fresh */ }

const calById = (id: string) => calendars.find((c) => c.id === id);
function ensureCalendar(id: string, name: string): CalMeta {
  const hit = calById(id);
  if (hit) return hit;
  const cal: CalMeta = {
    id, name,
    color: PALETTE[calendars.length % PALETTE.length]!,
    enabled: true,
  };
  calendars.push(cal);
  return cal;
}

// ── engine mapping (linear axis, shifted frame) ───────────────────────────
const SPY = 31556952;
const nowMs = Date.now();
const DAY_Y = 1 / 365.25;
// ── adaptive snap: precision follows the RENDERED grid ────────────────────
// A fixed 15-min snap under 1-hour columns places edges at positions the
// view doesn't show (false precision). Instead the snap unit is the finest
// clock unit whose width is readable (≥14px) inside the current fold cell —
// hour columns give 15-min snapping, phone daypart columns give hours,
// month-view day cells give whole days. Want finer? Zoom in.
const SNAP_LADDER = [
  5 * 60_000, 15 * 60_000, 30 * 60_000, 3600_000, 3 * 3600_000, 6 * 3600_000,
  86400_000, 7 * 86400_000,
];
let snapMs = 15 * 60_000; // refreshed from the cell under the pointer
function snapForCell(cell: { t0: number; t1: number; x0: number; x1: number }) {
  const cellMs = cell.t1 - cell.t0;
  const pxPerMs = (cell.x1 - cell.x0) / Math.max(1, cellMs);
  for (const u of SNAP_LADDER) if (u * pxPerMs >= 14) return u;
  return SNAP_LADDER[SNAP_LADDER.length - 1]!;
}
const snap = (ms: number) => Math.round(ms / snapMs) * snapMs;
const fmtRange = (e: CalEvent) =>
  e.allDay
    ? `${fmtDay.format(e.startMs)} · all day`
    : `${fmt.format(e.startMs)} → ${fmt.format(e.endMs)}`;

function toEv(e: CalEvent): TimelineEvent {
  const cal = calById(e.calId);
  const t = e.allDay ? e.startMs : toShifted(e.startMs);
  const dur = e.allDay ? e.endMs - e.startMs : toShifted(e.endMs) - t;
  return {
    y: (toShifted(nowMs) - t) / 1000 / SPY,
    tMs: t,
    precision: e.allDay
      ? { kind: "calendar", unit: "day" }
      : { kind: "calendar", unit: "minute" },
    label: e.summary,
    detail: `${cal?.name ?? e.calId} · ${fmtRange(e)}`,
    imp: e.allDay ? 0.6 : 0.5,
    cat: "cal",
    color: cal?.color,
    span: DAY_Y / 1440,
    // real extent → duration blocks in the fold (single-day all-day events
    // already render as their precision day-band; multi-day ones ribbon)
    durMs: e.allDay && dur <= 86400_000 ? undefined : dur,
  };
}

let source: TimelineSource;
function buildSource(): TimelineSource {
  const visible = events.filter((e) => calById(e.calId)?.enabled !== false);
  const src = createTimelineSource({
    logAxis: false,
    dataset: {
      title: "calendar",
      tracks: [{ cat: "cal", label: "agenda", color: "#7dd3fc" }],
      statics: visible.map(toEv),
      oldestYBP: 2,
      futureYears: 2,
      fitYBP: { top: 1.2 * DAY_Y, bot: -6 * DAY_Y },
      foldMaxContentRem: Infinity, // full-page grid — no text-column cap
    },
  });
  // Gantt bars carry density here — heat cells would paint slot columns
  // over the lanes and muddy the calendar read. Set BEFORE wiring onUpdate:
  // setHeatCells fires it, and at first boot `lane` doesn't exist yet (TDZ).
  src.setHeatCells(false);
  src.setOnUpdate(() => lane.invalidate());
  return src;
}
function rebuild(keepView = true) {
  const v = lane.view;
  source = buildSource();
  lane.setSource(source);
  if (keepView) lane.setView({ scrollY: v.scrollY, zoomY: v.zoomY });
  renderChips();
  emptyEl.style.display = events.length ? "none" : "";
  persist();
  Object.assign(window as object, { calSource: source });
}

source = buildSource();
const lane = createLane(canvas, {
  source,
  theme: resolveTheme(),
  maxDpr: 2,
  zoomIndicator: false, // the crosshair + cell highlight are the affordance
  onFrame: () => {
    updateGhost();
    updateHover();
  },
});
source.setOnUpdate(() => lane.invalidate());

// real time under a screen point — X-Y aware: in the folded grid the row
// comes from Y and the time-of-day from X (gridAt.t); the continuous axis
// falls back to the y-only mapping
const timeAtY = (sy: number): number | null => {
  const s = source.tMsForWorld(screenToWorldY(lane.view, sy));
  return s == null ? null : fromShifted(s);
};
const timeAtPoint = (sx: number, sy: number): number | null => {
  const cell = source.gridAt(sx, sy, lane.view);
  if (cell) {
    snapMs = snapForCell(cell); // snapping tracks what the grid shows here
    return fromShifted(cell.t);
  }
  return timeAtY(sy);
};
const yAtTime = (ms: number): number => {
  const w = source.worldForTMs(toShifted(ms));
  return (w - lane.view.scrollY) * lane.view.zoomY;
};

// ── chrome basics ─────────────────────────────────────────────────────────
const chipsEl = document.querySelector<HTMLDivElement>("#chips")!;
const emptyEl = document.querySelector<HTMLDivElement>("#empty")!;
const toastsEl = document.querySelector<HTMLDivElement>("#toasts")!;
const themeSel = document.querySelector<HTMLSelectElement>("#themeSel")!;

function toast(msg: string, ms = 3200) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  toastsEl.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function renderChips() {
  chipsEl.innerHTML = "";
  for (const c of calendars) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.setAttribute("aria-pressed", String(c.enabled));
    chip.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${c.name}`;
    chip.addEventListener("click", () => {
      c.enabled = !c.enabled;
      rebuild();
    });
    chipsEl.appendChild(chip);
  }
}

document.querySelector<HTMLButtonElement>("#theme-toggle")?.addEventListener("click", () => {
  prefs.theme = prefs.theme === "auto" ? "light" : prefs.theme === "light" ? "dark" : "auto";
  persistPrefs();
  applyTheme();
  toast(`theme: ${prefs.theme}`);
});

// ── preferences panel (⚙): time-zone omnibox + theme ──────────────────────
const prefsPanel = document.querySelector<HTMLDivElement>("#prefsPanel")!;
const tzInput = document.querySelector<HTMLInputElement>("#tzInput")!;
const tzList = document.querySelector<HTMLDataListElement>("#tzList")!;
{
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch { /* older engines: free-text input still works */ }
  tzList.innerHTML = zones.map((z) => `<option value="${z}"></option>`).join("");
  tzInput.placeholder = `System (${systemTz})`;
  if (prefs.tz) tzInput.value = prefs.tz;
}
document.querySelector("#prefsBtn")?.addEventListener("click", () => {
  prefsPanel.style.display = prefsPanel.style.display === "flex" ? "none" : "flex";
});
document.addEventListener("pointerdown", (e) => {
  if (prefsPanel.style.display !== "flex") return;
  const t = e.target as Node;
  if (prefsPanel.contains(t) || (t as HTMLElement).id === "prefsBtn") return;
  prefsPanel.style.display = "none";
});
function applyTz(next: string | undefined) {
  const target = next?.trim() || undefined;
  if (target) {
    try {
      zoneOffsetMs(Date.now(), target);
    } catch {
      toast(`unknown time zone: ${target}`);
      return;
    }
  }
  prefs.tz = target;
  tz = target ?? systemTz;
  makeFormatters();
  persistPrefs();
  rebuild();
  toast(`time zone: ${tz}`);
}
tzInput.addEventListener("change", () => applyTz(tzInput.value));
themeSel.addEventListener("change", () => {
  prefs.theme = themeSel.value as typeof prefs.theme;
  persistPrefs();
  applyTheme();
});

// ── import: file picker · drag-drop · URL ─────────────────────────────────
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const dropEl = document.querySelector<HTMLDivElement>("#drop")!;

function importText(text: string, fallbackName: string) {
  const cal = parseIcs(text);
  if (!cal.events.length) {
    toast(`no events found in ${fallbackName}`);
    return;
  }
  const name = (cal.name ?? fallbackName).replace(/\.ics$/i, "");
  const meta = ensureCalendar(`ics:${name}`, name);
  events = events.filter((e) => e.calId !== meta.id);
  for (const e of cal.events) events.push({ ...e, calId: meta.id });
  rebuild();
  focusRange(
    Math.min(...cal.events.map((e) => e.startMs)),
    Math.max(...cal.events.map((e) => e.endMs)),
  );
  toast(`${cal.events.length} events from ${name}`);
}

function focusRange(minMs: number, maxMs: number) {
  const w1 = source.worldForTMs(toShifted(minMs));
  const w2 = source.worldForTMs(toShifted(maxMs));
  const lo = Math.min(w1, w2);
  const span = Math.max(Math.abs(w2 - w1), DAY_Y);
  const pad = span * 0.08;
  lane.setView({ zoomY: lane.view.height / (span + pad * 2), scrollY: lo - pad });
}

document.querySelector<HTMLButtonElement>("#importBtn")?.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const f of fileInput.files ?? []) importText(await f.text(), f.name);
  fileInput.value = "";
});
window.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
  e.preventDefault();
  dropEl.style.display = "flex";
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) dropEl.style.display = "none";
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropEl.style.display = "none";
  for (const f of e.dataTransfer?.files ?? []) importText(await f.text(), f.name);
});

const urlInput = document.querySelector<HTMLInputElement>("#calurl")!;
urlInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const raw = urlInput.value.trim();
  if (!raw) return;
  const url = raw.replace(/^webcal:\/\//i, "https://");
  toast("fetching…", 1500);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    importText(await r.text(), url.split("/").pop() ?? "feed");
    urlInput.value = "";
  } catch {
    toast("that server blocks browser access (CORS) — download the .ics and drop it here", 6000);
  }
});

// ── export ────────────────────────────────────────────────────────────────
document.querySelector<HTMLButtonElement>("#saveBtn")?.addEventListener("click", () => {
  const visible = events.filter((e) => calById(e.calId)?.enabled !== false);
  if (!visible.length) {
    toast("nothing to save yet");
    return;
  }
  const blob = new Blob([serializeIcs(visible, "rgui calendar")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rgui-calendar.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// ── placeholder (UI state until saved) + input grammar ────────────────────
// The span renders as WRAPPED ROW FRAGMENTS (text-selection shape) via
// spanRects: X = time within the day row, Y = the day. Creating, resizing
// and moving all read the pointer in that x-y plane.
const ghostEl = document.querySelector<HTMLDivElement>("#ghost")!;
const ghostFrags = document.querySelector<HTMLDivElement>("#ghostFrags")!;
const ghostLabel = document.querySelector<HTMLSpanElement>("#ghostLabel")!;
const handleStart = document.querySelector<HTMLDivElement>("#handleStart")!;
const handleEnd = document.querySelector<HTMLDivElement>("#handleEnd")!;
const cellhlEl = document.querySelector<HTMLDivElement>("#cellhl")!;

// the active span (real ms): a NEW placeholder, or — with `editing` set — a
// saved event picked up for move/resize (committed back on release)
let ph: { t0: number; t1: number; editing?: CalEvent } | null = null;
// a press on an event that hasn't crossed the drag threshold yet
let evPending: { ev: CalEvent; x: number; y: number; id: number } | null = null;
let op:
  | { kind: "size"; id: number; level: string | null }
  | { kind: "resize"; edge: "start" | "end"; id: number; level: string | null }
  | { kind: "move"; id: number; lastT: number; level: string | null }
  | null = null;
let suppressClickUntil = 0;

const levelAt = (sx: number, sy: number): string | null =>
  source.gridAt(sx, sy, lane.view)?.level ?? null;

function phBounds(): { a: number; b: number } | null {
  if (!ph) return null;
  const a = Math.min(ph.t0, ph.t1);
  return { a, b: Math.max(ph.t0, ph.t1, a + snapMs) };
}
function updateGhost() {
  const b = phBounds();
  if (!b) {
    ghostEl.style.display = "none";
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const rects = source.spanRects(
    toShifted(b.a),
    toShifted(b.b),
    lane.view,
    op?.level ?? undefined,
  );
  ghostEl.style.display = "block";
  // rebuild the fragment stack (a handful of divs — cheap)
  while (ghostFrags.children.length > rects.length) ghostFrags.lastChild!.remove();
  while (ghostFrags.children.length < rects.length) {
    const d = document.createElement("div");
    d.className = "frag";
    ghostFrags.appendChild(d);
  }
  rects.forEach((r, i) => {
    const d = ghostFrags.children[i] as HTMLDivElement;
    d.style.left = `${rect.left + r.x0}px`;
    d.style.top = `${rect.top + r.y0}px`;
    d.style.width = `${Math.max(r.x1 - r.x0, 6)}px`;
    d.style.height = `${Math.max(r.y1 - r.y0, 10)}px`;
  });
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (first && last) {
    // handles sit a step INSIDE the span: centered on the boundary they'd
    // read as the neighboring row, and a 1px drag would jump a whole day
    handleStart.style.left = `${rect.left + first.x0 + 8}px`;
    handleStart.style.top = `${rect.top + Math.min(first.y0 + 8, (first.y0 + first.y1) / 2)}px`;
    handleEnd.style.left = `${rect.left + last.x1 - 8}px`;
    handleEnd.style.top = `${rect.top + Math.max(last.y1 - 8, (last.y0 + last.y1) / 2)}px`;
    ghostLabel.style.left = `${rect.left + first.x0 + 6}px`;
    ghostLabel.style.top = `${rect.top + first.y0 - 20}px`;
    ghostLabel.textContent = `${fmt.format(b.a)} → ${fmt.format(b.b)}`;
    if (createSheet.style.display === "flex")
      positionSheet(createSheet, rect.top + (first.y0 + last.y1) / 2);
  }
}
function dropPlaceholder() {
  ph = null;
  op = null;
  updateGhost();
  closeCreateSheet();
}

function beginPlaceholder(t: number, opNext: typeof op, kind: "size" | "tap") {
  const t0 = snap(t);
  // tap default: one visible slot-ish (≥30 min) so the span is grabbable
  ph = { t0, t1: t0 + (kind === "tap" ? Math.max(30 * 60_000, snapMs) : snapMs) };
  op = opNext;
  updateGhost();
  if (kind === "tap") openCreateSheet();
}

// pointer-type grammar (capture phase so the lane never sees create drags)
canvas.addEventListener(
  "pointerdown",
  (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const draggish = e.pointerType === "mouse" || e.pointerType === "pen";
    if (!draggish) return; // touch: the lane pans; taps handled on click
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // a press on an existing event: a still release inspects (click), a
    // drag past the threshold PICKS THE EVENT UP and moves it on the grid
    const overEv = resolveEventHit(sx, sy);
    if (overEv) {
      e.stopPropagation();
      e.preventDefault();
      evPending = { ev: overEv, x: sx, y: sy, id: e.pointerId };
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const t = timeAtPoint(sx, sy);
    if (t == null || !Number.isFinite(t)) return;
    closeDetail();
    beginPlaceholder(t, { kind: "size", id: e.pointerId, level: levelAt(sx, sy) }, "size");
  },
  { capture: true },
);
canvas.addEventListener(
  "pointermove",
  (e) => {
    if (evPending && e.pointerId === evPending.id) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (Math.hypot(sx - evPending.x, sy - evPending.y) > 6) {
        const { ev } = evPending;
        evPending = null;
        const t = timeAtPoint(sx, sy);
        if (t != null && Number.isFinite(t)) {
          closeDetail();
          closeCreateSheet();
          ph = { t0: ev.startMs, t1: ev.endMs, editing: ev };
          op = { kind: "move", id: e.pointerId, lastT: t, level: levelAt(sx, sy) };
          updateGhost();
        }
      }
    }
    if (op && "id" in op && e.pointerId === op.id && ph) {
      e.stopPropagation();
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const t = timeAtPoint(e.clientX - rect.left, e.clientY - rect.top);
      if (t == null || !Number.isFinite(t)) return;
      applyOpTime(t);
    }
  },
  { capture: true },
);
function applyOpTime(t: number) {
  if (!op || !ph) return;
  if (op.kind === "size") ph.t1 = snap(t);
  else if (op.kind === "resize") {
    if (op.edge === "start") ph.t0 = snap(t);
    else ph.t1 = snap(t);
  } else {
    // move: x drags time-of-day, y drags days — both fall out of the same
    // pointer→time inverse; the span glides rigidly (duration preserved)
    const dt = t - op.lastT;
    op.lastT = t;
    ph.t0 += dt;
    ph.t1 += dt;
  }
  updateGhost();
}
// write the edited span back into its saved event (one rebuild per release)
function commitEdit() {
  if (!ph?.editing) return;
  const b = phBounds()!;
  const ev = ph.editing;
  if (ev.allDay) {
    // all-day events live on whole date boundaries, whatever the snap says
    const D = 86400_000;
    ev.startMs = Math.round(b.a / D) * D;
    ev.endMs = Math.max(ev.startMs + D, Math.round(b.b / D) * D);
  } else {
    ev.startMs = b.a;
    ev.endMs = b.b;
  }
  rebuild();
  if (inspected === ev) detailTime.textContent = fmtRange(ev);
}
function endPointer(e: PointerEvent) {
  if (evPending && e.pointerId === evPending.id) evPending = null; // still press → click inspects
  if (!op || !("id" in op) || e.pointerId !== op.id) return;
  e.stopPropagation();
  const was = op.kind;
  if (was === "move" && ph) {
    // settle the moved span onto the snap grid, duration intact
    const dur = ph.t1 - ph.t0;
    ph.t0 = snap(ph.t0);
    ph.t1 = ph.t0 + dur;
  }
  op = null;
  suppressClickUntil = performance.now() + 400;
  if (ph?.editing) commitEdit();
  else if (was === "size") openCreateSheet();
  updateGhost();
}
canvas.addEventListener("pointerup", endPointer, { capture: true });
canvas.addEventListener("pointercancel", endPointer, { capture: true });

// fragment body = MOVE (grab anywhere on the span, drag in the x-y plane)
ghostFrags.addEventListener("pointerdown", (e) => {
  if (!ph) return;
  const frag = (e.target as HTMLElement).closest(".frag");
  if (!frag) return;
  e.stopPropagation();
  e.preventDefault();
  try { (frag as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic pointer (e2e) */ }
  const rect = canvas.getBoundingClientRect();
  const t = timeAtPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (t == null) return;
  op = { kind: "move", id: e.pointerId, lastT: t, level: levelAt(e.clientX - rect.left, e.clientY - rect.top) };
});
ghostFrags.addEventListener("pointermove", (e) => {
  if (!op || op.kind !== "move" || e.pointerId !== op.id) return;
  const rect = canvas.getBoundingClientRect();
  const t = timeAtPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (t != null && Number.isFinite(t)) applyOpTime(t);
});
ghostFrags.addEventListener("pointerup", (e) => {
  if (op?.kind === "move" && e.pointerId === op.id) endPointer(e);
});

// handles resize their edge — in the x-y plane too
for (const h of [handleStart, handleEnd]) {
  h.addEventListener("pointerdown", (e) => {
    if (!ph) return;
    e.stopPropagation();
    e.preventDefault();
    try { h.setPointerCapture(e.pointerId); } catch { /* synthetic pointer (e2e) */ }
    const b = phBounds()!;
    ph.t0 = b.a; // normalize: t0 = start edge, t1 = end edge
    ph.t1 = b.b;
    const rect = canvas.getBoundingClientRect();
    op = {
      kind: "resize",
      edge: h.dataset.edge as "start" | "end",
      id: e.pointerId,
      level: levelAt(e.clientX - rect.left, e.clientY - rect.top),
    };
  });
  h.addEventListener("pointermove", (e) => {
    if (!op || op.kind !== "resize" || e.pointerId !== op.id) return;
    const rect = canvas.getBoundingClientRect();
    const t = timeAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (t != null && Number.isFinite(t)) applyOpTime(t);
  });
  h.addEventListener("pointerup", (e) => {
    if (op?.kind === "resize" && e.pointerId === op.id) {
      op = null;
      if (ph?.editing) commitEdit();
      updateGhost();
    }
  });
}

// ── hover: crosshair companion — highlight the grid cell under the pointer
let hoverPos: { x: number; y: number } | null = null;
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return; // no hover on touch
  hoverPos = { x: e.offsetX, y: e.offsetY };
  updateHover();
});
canvas.addEventListener("pointerleave", () => {
  hoverPos = null;
  updateHover();
});
function updateHover() {
  const cell = hoverPos && !op ? source.gridAt(hoverPos.x, hoverPos.y, lane.view) : null;
  if (!cell) {
    cellhlEl.style.display = "none";
    return;
  }
  const rect = canvas.getBoundingClientRect();
  cellhlEl.style.display = "block";
  cellhlEl.style.left = `${rect.left + cell.x0}px`;
  cellhlEl.style.width = `${cell.x1 - cell.x0}px`;
  cellhlEl.style.top = `${rect.top + cell.y0}px`;
  cellhlEl.style.height = `${cell.y1 - cell.y0}px`;
}

// ── create / detail panels: floating when there's room, bottom sheet else ─
function positionSheet(sheet: HTMLElement, anchorY: number) {
  const wide = innerWidth >= 700;
  sheet.classList.toggle("floating", wide);
  if (!wide) {
    sheet.style.left = "";
    sheet.style.top = "";
    return;
  }
  const w = 300;
  const pad = 12;
  sheet.style.left = `${innerWidth - w - pad - 8}px`;
  const h = sheet.offsetHeight || 190;
  sheet.style.top = `${Math.max(54, Math.min(innerHeight - h - pad, anchorY - h / 2))}px`;
}

const createSheet = document.querySelector<HTMLDivElement>("#createSheet")!;
const createTitle = document.querySelector<HTMLInputElement>("#createTitle")!;
const createTime = document.querySelector<HTMLDivElement>("#createTime")!;

function openCreateSheet() {
  const b = phBounds();
  if (!b) return;
  createTitle.value = createTitle.value; // keep half-typed titles across resizes
  createTime.textContent = `${fmt.format(b.a)} → ${fmt.format(b.b)}`;
  createSheet.style.display = "flex";
  positionSheet(createSheet, yAtTime((b.a + b.b) / 2) + canvas.getBoundingClientRect().top);
  createTitle.focus();
}
function closeCreateSheet() {
  createSheet.style.display = "none";
  createTitle.value = "";
}
document.querySelector("#createCancel")?.addEventListener("click", dropPlaceholder);
document.querySelector("#createSave")?.addEventListener("click", saveDraft);
createTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveDraft();
  if (e.key === "Escape") dropPlaceholder();
});
function saveDraft() {
  const b = phBounds();
  if (!b || ph?.editing) return; // edits commit on release, not via the sheet
  ensureCalendar(MINE, "My events");
  events.push({
    uid: `mine-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    summary: createTitle.value.trim() || "New event",
    startMs: b.a,
    endMs: b.b,
    allDay: false,
    calId: MINE,
  });
  dropPlaceholder();
  rebuild();
}

// keep the create-time line fresh while resizing
const createTimeSync = () => {
  const b = phBounds();
  if (b && createSheet.style.display === "flex")
    createTime.textContent = `${fmt.format(b.a)} → ${fmt.format(b.b)}`;
  requestAnimationFrame(createTimeSync);
};
requestAnimationFrame(createTimeSync);

// ＋ button: placeholder at the viewport center (discoverability path)
document.querySelector<HTMLButtonElement>("#newBtn")?.addEventListener("click", () => {
  const t = timeAtY(lane.view.height / 2);
  if (t == null) return;
  beginPlaceholder(t, null, "tap");
});

// ── tap / click: inspect an event, or drop a placeholder on empty grid ────
const detailSheet = document.querySelector<HTMLDivElement>("#detailSheet")!;
const detailTitle = document.querySelector<HTMLInputElement>("#detailTitle")!;
const detailTime = document.querySelector<HTMLDivElement>("#detailTime")!;
const detailCal = document.querySelector<HTMLDivElement>("#detailCal")!;
let inspected: CalEvent | null = null;

function closeDetail() {
  detailSheet.style.display = "none";
  inspected = null;
  if (ph?.editing) {
    ph = null;
    updateGhost();
  }
}

function resolveEventHit(sx: number, sy: number): CalEvent | null {
  const hit = source.eventAt(sx, sy, lane.view);
  if (!hit) return null;
  const t = timeAtPoint(sx, sy) ?? 0;
  const candidates = events.filter(
    (ev) => ev.summary.startsWith(hit.title) && calById(ev.calId)?.enabled !== false,
  );
  candidates.sort((a, b) => Math.abs(a.startMs - t) - Math.abs(b.startMs - t));
  return candidates[0] ?? null;
}
canvas.addEventListener("click", (e) => {
  if (performance.now() < suppressClickUntil) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const ev = resolveEventHit(sx, sy);
  if (ev) {
    if (ph) dropPlaceholder();
    inspected = ev;
    detailTitle.value = ev.summary;
    detailTime.textContent = fmtRange(ev);
    detailCal.textContent =
      `calendar: ${calById(ev.calId)?.name ?? ev.calId}` +
      (ev.recurring ? " · recurring (first instance)" : "");
    detailSheet.style.display = "flex";
    positionSheet(detailSheet, e.clientY);
    // selection ghost: the event's span grows handles — resize/move it
    // directly (this is also the touch path to moving events)
    ph = { t0: ev.startMs, t1: ev.endMs, editing: ev };
    updateGhost();
    return;
  }
  if (ph) {
    const wasEditing = !!ph.editing;
    dropPlaceholder(); // click-away deselects / discards the pending span
    if (wasEditing) closeDetail();
    return;
  }
  closeDetail();
  const t = timeAtPoint(sx, sy);
  if (t == null || !Number.isFinite(t)) return;
  beginPlaceholder(t, null, "tap"); // tap/click on empty grid → 30-min span
});
document.querySelector("#detailClose")?.addEventListener("click", () => {
  applyRename();
  closeDetail();
});
document.querySelector("#detailDelete")?.addEventListener("click", () => {
  if (!inspected) return;
  events = events.filter((e) => e !== inspected);
  closeDetail();
  rebuild();
  toast("event deleted");
});
detailTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    applyRename();
    closeDetail();
  }
});
function applyRename() {
  if (!inspected) return;
  const t = detailTitle.value.trim();
  if (t && t !== inspected.summary) {
    inspected.summary = t;
    rebuild();
  }
}

// ── search omnibox (⌘K / Ctrl+K) ──────────────────────────────────────────
const qEl = document.querySelector<HTMLInputElement>("#q")!;
const qSuggest = document.querySelector<HTMLDivElement>("#qsuggest")!;
type Hit = ReturnType<TimelineSource["find"]>[number];
let qHits: Hit[] = [];
let qIdx = -1;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function renderQ() {
  qSuggest.innerHTML = qHits
    .map(
      (h, i) =>
        `<div class="hit${i === qIdx ? " active" : ""}" data-i="${i}">` +
        `<span class="swatch" style="background:${h.color}"></span>` +
        `<span>${esc(h.label)}</span>` +
        (h.detail ? `<span class="det">${esc(h.detail.split(" · ")[1] ?? h.detail)}</span>` : "") +
        `</div>`,
    )
    .join("");
}
function clearQ() {
  qHits = [];
  qIdx = -1;
  renderQ();
}
function focusHit(h: Hit) {
  lane.focus({ center: h.center, zoom: lane.view.height / h.scale });
  source.setPulse(h);
  clearQ();
  qEl.blur();
}
qEl.addEventListener("input", () => {
  const q = qEl.value.trim();
  qHits = q ? source.find(q, 8) : [];
  qIdx = qHits.length ? 0 : -1;
  renderQ();
});
qEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    qIdx = Math.min(qHits.length - 1, qIdx + 1);
    renderQ();
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    qIdx = Math.max(0, qIdx - 1);
    renderQ();
    e.preventDefault();
  } else if (e.key === "Enter") {
    if (qHits[qIdx]) focusHit(qHits[qIdx]!);
  } else if (e.key === "Escape") {
    qEl.value = "";
    clearQ();
    qEl.blur();
  }
});
qEl.addEventListener("blur", () => setTimeout(clearQ, 140));
qSuggest.addEventListener("mousedown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".hit");
  if (!el) return;
  e.preventDefault();
  focusHit(qHits[+el.dataset.i!]!);
});
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    qEl.focus();
    qEl.select();
  }
});

// ── boot ──────────────────────────────────────────────────────────────────
applyTheme();
renderChips();
emptyEl.style.display = events.length ? "none" : "";
if (events.length) rebuild(false);
Object.assign(window as object, { lane, calSource: source });
