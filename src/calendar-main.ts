/**
 * rgui calendar demo — a calendar where ZOOM replaces view switching.
 *
 * One lane on the linear time axis: the per-track fold ladder renders year ⇄
 * month ⇄ week ⇄ day continuously, so there is no view switcher — pinch or
 * wheel is the navigation. All calendars overlay in ONE grid (mobile-first;
 * three side-by-side tracks would each be too narrow to fold on a phone),
 * tinted per source calendar via the engine's per-event color override;
 * chips toggle calendars and rebuild the source (the same replace-the-source
 * pattern the tree and git demos use).
 *
 * Gesture grammar, identical on desktop and mobile:
 *   drag / flick        → pan (navigation stays cheapest)
 *   press-hold ~260ms   → create: ghost snaps to the slot, drag sizes it,
 *                         release opens the title sheet (Alt+drag = instant)
 *   tap an event        → detail sheet (rename / delete)
 *
 * Import: drop an .ics anywhere, 📂 file picker (the only mobile path), or a
 * webcal/https URL — CORS failures say exactly that. Export merges visible
 * events into one .ics. Everything autosaves to localStorage; the file is
 * interchange, not the save mechanism.
 */
import { parseIcs, serializeIcs, type IcsEvent } from "./calendar/ics.js";
import { createLane } from "./lane/lane.js";
import {
  createTimelineSource,
  type TimelineEvent,
  type TimelineSource,
} from "./lane/timeline.js";
import { screenToWorldY } from "./lane/view.js";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;

// ── model ─────────────────────────────────────────────────────────────────
interface CalMeta {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
}
type CalEvent = IcsEvent & { calId: string };

const PALETTE = ["#60a5fa", "#f3820d", "#2dd4bf", "#f472b6", "#ffd21c", "#b25ce0", "#7dd3fc"];
const MINE = "mine"; // the built-in calendar drag-created events land in

let calendars: CalMeta[] = [];
let events: CalEvent[] = [];

const STORE_KEY = "rgui-calendar";
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ calendars, events }));
  } catch { /* private mode / quota — session-only then */ }
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
    id,
    name,
    color: PALETTE[calendars.length % PALETTE.length]!,
    enabled: true,
  };
  calendars.push(cal);
  return cal;
}

// ── time helpers (mirror the engine's linear axis) ────────────────────────
const SPY = 31556952; // seconds per Julian year (engine constant)
const nowMs = Date.now(); // same page load as the engine's PRESENT_EPOCH
const yOfMs = (ms: number) => (nowMs - ms) / 1000 / SPY;
const DAY_Y = 1 / 365.25;
const SNAP_MS = 15 * 60_000;
const snap = (ms: number) => Math.round(ms / SNAP_MS) * SNAP_MS;
const fmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit",
});
const fmtDay = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
});
const fmtRange = (e: CalEvent) =>
  e.allDay
    ? `${fmtDay.format(e.startMs)} · all day`
    : `${fmt.format(e.startMs)} → ${fmt.format(e.endMs)}`;

function toEv(e: CalEvent): TimelineEvent {
  const cal = calById(e.calId);
  return {
    y: yOfMs(e.startMs),
    tMs: e.startMs,
    precision: e.allDay
      ? { kind: "calendar", unit: "day" }
      : { kind: "calendar", unit: "minute" },
    label: e.summary,
    detail: `${cal?.name ?? e.calId} · ${fmtRange(e)}`,
    imp: e.allDay ? 0.6 : 0.5,
    cat: "cal",
    color: cal?.color,
    span: DAY_Y / 1440, // exact times — no uncertainty band
  };
}

// ── source (rebuilt wholesale on every change) ────────────────────────────
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
      // a calendar looks FORWARD: yesterday through the coming week
      fitYBP: { top: 1.2 * DAY_Y, bot: -6 * DAY_Y },
    },
  });
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
  theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  maxDpr: 2,
});
source.setOnUpdate(() => lane.invalidate());

// ── chrome ────────────────────────────────────────────────────────────────
const chipsEl = document.querySelector<HTMLDivElement>("#chips")!;
const emptyEl = document.querySelector<HTMLDivElement>("#empty")!;
const toastsEl = document.querySelector<HTMLDivElement>("#toasts")!;

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
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("rgui-theme", next);
  lane.setTheme(next);
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
  // re-import replaces that calendar's events (refresh semantics)
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
  const w1 = source.worldForTMs(minMs);
  const w2 = source.worldForTMs(maxMs);
  const lo = Math.min(w1, w2);
  const span = Math.max(Math.abs(w2 - w1), DAY_Y);
  const pad = span * 0.08;
  lane.setView({
    zoomY: lane.view.height / (span + pad * 2),
    scrollY: lo - pad,
  });
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

// ── create: press-and-hold drag (unified desktop + mobile) ────────────────
const ghostEl = document.querySelector<HTMLDivElement>("#ghost")!;
const HOLD_MS = 260;
const MOVE_TOL = 7;

const timeAtY = (sy: number): number | null =>
  source.tMsForWorld(screenToWorldY(lane.view, sy));
const yAtTime = (ms: number): number => {
  const w = source.worldForTMs(ms);
  return (w - lane.view.scrollY) * lane.view.zoomY;
};

let pending: { x: number; y: number; id: number; timer: number } | null = null;
let creating: { t0: number; t1: number; id: number } | null = null;
let suppressClickUntil = 0;

function updateGhost() {
  if (!creating) {
    ghostEl.style.display = "none";
    return;
  }
  const a = Math.min(creating.t0, creating.t1);
  const b = Math.max(creating.t0, creating.t1, a + SNAP_MS);
  const y0 = yAtTime(a);
  const y1 = yAtTime(b);
  const rect = canvas.getBoundingClientRect();
  ghostEl.style.display = "block";
  ghostEl.style.left = `${rect.left + 90}px`;
  ghostEl.style.right = "12px";
  ghostEl.style.width = "auto";
  ghostEl.style.top = `${rect.top + Math.min(y0, y1)}px`;
  ghostEl.style.height = `${Math.max(Math.abs(y1 - y0), 14)}px`;
  ghostEl.textContent = `${fmt.format(a)} → ${fmt.format(b)}`;
}

let handingOff = false; // the synthetic pan-ending pointerup must not finish a create
function startCreate(x: number, y: number, pointerId: number) {
  const t = timeAtY(y);
  if (t == null || !Number.isFinite(t)) return;
  // hand the gesture over: end the lane's pan (same pointer id) — the view
  // moved ≤ MOVE_TOL px, which reads as stillness
  handingOff = true;
  canvas.dispatchEvent(new PointerEvent("pointerup", { pointerId, bubbles: true }));
  handingOff = false;
  creating = { t0: snap(t), t1: snap(t) + 30 * 60_000, id: pointerId };
  updateGhost();
}

canvas.addEventListener(
  "pointerdown",
  (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    if (e.altKey) {
      // desktop power path: Alt+drag creates immediately
      e.stopPropagation();
      e.preventDefault();
      startCreate(e.offsetX, e.offsetY, e.pointerId);
      return;
    }
    const id = e.pointerId;
    const x = e.offsetX;
    const y = e.offsetY;
    pending = {
      x, y, id,
      timer: window.setTimeout(() => {
        pending = null;
        startCreate(x, y, id);
      }, HOLD_MS),
    };
  },
  { capture: true },
);
canvas.addEventListener(
  "pointermove",
  (e) => {
    if (pending && e.pointerId === pending.id) {
      if (Math.hypot(e.offsetX - pending.x, e.offsetY - pending.y) > MOVE_TOL) {
        clearTimeout(pending.timer);
        pending = null; // it's a pan — the lane already has it
      }
    }
    if (creating && e.pointerId === creating.id) {
      e.stopPropagation();
      e.preventDefault();
      const t = timeAtY(e.offsetY);
      if (t != null && Number.isFinite(t)) creating.t1 = snap(t);
      updateGhost();
    }
  },
  { capture: true },
);
function endPointer(e: PointerEvent) {
  if (pending && e.pointerId === pending.id) {
    clearTimeout(pending.timer);
    pending = null;
  }
  if (creating && e.pointerId === creating.id && !handingOff) {
    e.stopPropagation();
    const a = Math.min(creating.t0, creating.t1);
    const b = Math.max(creating.t0, creating.t1, a + SNAP_MS);
    creating = null;
    updateGhost();
    suppressClickUntil = performance.now() + 400;
    openCreateSheet(a, b);
  }
}
canvas.addEventListener("pointerup", endPointer, { capture: true });
canvas.addEventListener("pointercancel", endPointer, { capture: true });

// ── sheets ────────────────────────────────────────────────────────────────
const createSheet = document.querySelector<HTMLDivElement>("#createSheet")!;
const createTitle = document.querySelector<HTMLInputElement>("#createTitle")!;
const createTime = document.querySelector<HTMLDivElement>("#createTime")!;
let draft: { startMs: number; endMs: number } | null = null;

function openCreateSheet(startMs: number, endMs: number) {
  draft = { startMs, endMs };
  createTitle.value = "";
  createTime.textContent = `${fmt.format(startMs)} → ${fmt.format(endMs)}`;
  createSheet.style.display = "flex";
  createTitle.focus();
}
function closeCreateSheet() {
  createSheet.style.display = "none";
  draft = null;
}
document.querySelector("#createCancel")?.addEventListener("click", closeCreateSheet);
document.querySelector("#createSave")?.addEventListener("click", saveDraft);
createTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveDraft();
  if (e.key === "Escape") closeCreateSheet();
});
function saveDraft() {
  if (!draft) return;
  ensureCalendar(MINE, "My events");
  events.push({
    uid: `mine-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    summary: createTitle.value.trim() || "New event",
    startMs: draft.startMs,
    endMs: draft.endMs,
    allDay: false,
    calId: MINE,
  });
  closeCreateSheet();
  rebuild();
}

// ＋ button: default 1-h event at the viewport center (discoverability path)
document.querySelector<HTMLButtonElement>("#newBtn")?.addEventListener("click", () => {
  const t = timeAtY(lane.view.height / 2);
  if (t == null) return;
  const start = snap(t);
  openCreateSheet(start, start + 60 * 60_000);
});

// ── tap-to-inspect ────────────────────────────────────────────────────────
const detailSheet = document.querySelector<HTMLDivElement>("#detailSheet")!;
const detailTitle = document.querySelector<HTMLInputElement>("#detailTitle")!;
const detailTime = document.querySelector<HTMLDivElement>("#detailTime")!;
const detailCal = document.querySelector<HTMLDivElement>("#detailCal")!;
let inspected: CalEvent | null = null;

canvas.addEventListener("click", (e) => {
  if (performance.now() < suppressClickUntil) return;
  const rect = canvas.getBoundingClientRect();
  const hit = source.eventAt(e.clientX - rect.left, e.clientY - rect.top, lane.view);
  if (!hit) {
    detailSheet.style.display = "none";
    inspected = null;
    return;
  }
  // resolve the hit title back to a model event; ties break by proximity to
  // the time under the pointer
  const t = timeAtY(e.clientY - rect.top) ?? 0;
  const candidates = events.filter((ev) => ev.summary.startsWith(hit.title));
  candidates.sort((a, b) => Math.abs(a.startMs - t) - Math.abs(b.startMs - t));
  const ev = candidates[0];
  if (!ev) return;
  inspected = ev;
  detailTitle.value = ev.summary;
  detailTime.textContent = fmtRange(ev);
  detailCal.textContent = `calendar: ${calById(ev.calId)?.name ?? ev.calId}` + (ev.recurring ? " · recurring (first instance)" : "");
  detailSheet.style.display = "flex";
});
document.querySelector("#detailClose")?.addEventListener("click", () => {
  applyRename();
  detailSheet.style.display = "none";
  inspected = null;
});
document.querySelector("#detailDelete")?.addEventListener("click", () => {
  if (!inspected) return;
  events = events.filter((e) => e !== inspected);
  detailSheet.style.display = "none";
  inspected = null;
  rebuild();
  toast("event deleted");
});
detailTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    applyRename();
    detailSheet.style.display = "none";
    inspected = null;
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

// ── boot ──────────────────────────────────────────────────────────────────
renderChips();
emptyEl.style.display = events.length ? "none" : "";
if (events.length) rebuild(false);
Object.assign(window as object, { lane, calSource: source });
