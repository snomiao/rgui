/**
 * rgui lane — the engine for limited-visual-width / vertical-zoom rendering.
 *
 * `createLane(canvas, { source })` owns the {@link LaneView}, a dpr-aware
 * Canvas-2D render loop, and all input (scroll = move, ⌘/ctrl-scroll or pinch
 * = zoom, drag = move, R/F zoom, W/S move). It is deliberately dataset-blind:
 * everything domain-specific lives behind {@link LaneSource}, so folder trees
 * (src/lane/tree.ts) and time series (src/lane/timeseries.ts) share one engine.
 */
import { AccModel2D } from "../core/accModel.js";
import { DEFAULT_RULE, resolveRule, type RgRule } from "../core/rule.js";
import {
  resolveTheme,
  withAlpha,
  type RgTheme,
  type RgThemeInput,
} from "../core/theme.js";
import {
  clampScroll,
  lodStep,
  screenToWorldY,
  visibleSpan,
  worldToScreenY,
  zoomAt,
  type LaneView,
} from "./view.js";

/** per-frame context handed to a source's draw(). */
export interface LaneEnv {
  theme: RgTheme;
  rule: RgRule;
  size: { width: number; height: number };
  /** readable flow-axis step (world units per readable cell) at this zoom */
  lodStep: number;
}

/** a 1-D dataset the lane can render. World coords run along the flow axis. */
export interface LaneSource {
  /** short label (shown in the debug HUD) */
  title: string;
  /** flow-axis world bounds, for scroll clamping and auto-fit */
  extent(): { min: number; max: number };
  /** draw the currently visible window; width is pinned, so lay x out in px */
  draw(ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv): void;
  /**
   * comfortable max zoom (px per world unit). Default 240 — one world unit can
   * grow to a large-but-finite row. Sources with tiny units may raise it.
   */
  maxZoom?: number;
  /** extra HUD line (e.g. hovered path / value under the cursor) */
  hudLine?: (view: LaneView) => string | null;
  /**
   * notable world-Y positions the zoom anchor gravitates toward. When the
   * cursor is near one, zooming keeps THAT point fixed (so a not-quite-aimed
   * target doesn't drift off-screen); far from any, plain cursor zoom. The
   * pull is a smooth gaussian, not a hard snap.
   */
  snapTargets?: (view: LaneView) => number[];
  /**
   * double-click focus: given the click's screen-y, return the world center to
   * scroll to and the zoom to scale to (the target's natural scale), or null.
   */
  focusAt?: (screenY: number, view: LaneView) => { center: number; zoom: number } | null;
}

export interface LaneOptions {
  source: LaneSource;
  theme?: RgThemeInput;
  rule?: Partial<RgRule>;
  debug?: HTMLElement | null;
  /** cap the backing-store scale (raster cost grows with dpr²) */
  maxDpr?: number;
  /**
   * keyboard navigation (default true), CapsLockX AccModel physics (see
   * core/accModel.ts): R/F zoom in/out, W/S (and ↑/↓) scroll — both with
   * time-based acceleration, so a longer hold travels faster. Identical feel
   * to the infinite-canvas viewer.
   */
  keyboard?: boolean;
  /** accel rates (units per first-second of hold); defaults 1600 / 1600 */
  keyboardSpeed?: { scroll?: number; zoom?: number };
  onFrame?: (view: LaneView) => void;
}

export interface Lane {
  readonly view: LaneView;
  invalidate(): void;
  setSource(source: LaneSource): void;
  setTheme(theme: RgThemeInput): void;
  /** re-fit the whole extent into the viewport */
  fit(): void;
  destroy(): void;
}

export function createLane(
  canvas: HTMLCanvasElement,
  opts: LaneOptions,
): Lane {
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) throw new Error("2d context unavailable");
  const ctx = maybeCtx; // capture the narrowed non-null type into the closures

  let source = opts.source;
  let theme = resolveTheme(opts.theme);
  let rule = resolveRule(opts.rule);
  const debug = opts.debug ?? null;

  const view: LaneView = { scrollY: 0, zoomY: 1, width: 0, height: 0 };
  let dpr = 1;
  let fitted = false; // becomes true after the first successful auto-fit

  const zoomLimits = () => {
    const { min, max } = source.extent();
    const span = Math.max(1e-9, max - min);
    const fit = view.height > 0 ? view.height / span : 1;
    return { min: fit * 0.5, max: Math.max(fit * 4, source.maxZoom ?? 240) };
  };

  // Gravitate the zoom anchor toward the nearest notable point so a
  // not-quite-aimed target doesn't drift off-screen as you keep zooming. The
  // pull is gaussian: ~full lock within SNAP_SIGMA px, fading to plain cursor
  // zoom farther out — smooth, never a hard switch.
  const SNAP_SIGMA = 44; // px capture radius
  function zoomAnchor(rawScreenY: number): number {
    const targets = source.snapTargets?.(view);
    if (!targets || !targets.length) return rawScreenY;
    let bestTy = rawScreenY;
    let bestD = Infinity;
    for (const wy of targets) {
      const ty = worldToScreenY(view, wy);
      const d = Math.abs(ty - rawScreenY);
      if (d < bestD) {
        bestD = d;
        bestTy = ty;
      }
    }
    const g = Math.exp(-(bestD * bestD) / (SNAP_SIGMA * SNAP_SIGMA));
    return rawScreenY + g * (bestTy - rawScreenY);
  }

  // Double-click focus: smoothly bring a point to the viewport centre and zoom
  // to its natural scale. Zoom tweens in log space (perceptually even); the
  // focused world point drives scrollY each frame so it lands dead-centre.
  const FOCUS_MS = 380;
  let focusAnim: {
    c0: number; c1: number; z0: number; z1: number; t0: number;
  } | null = null;
  let focusRaf = 0;
  function focusTo(center: number, zoom: number) {
    const { min, max } = zoomLimits();
    focusAnim = {
      c0: screenToWorldY(view, view.height / 2),
      c1: center,
      z0: view.zoomY,
      z1: Math.min(max, Math.max(min, zoom)),
      t0: performance.now(),
    };
    if (!focusRaf) focusRaf = requestAnimationFrame(focusTick);
  }
  function focusTick() {
    focusRaf = 0;
    if (!focusAnim) return;
    const t = Math.min(1, (performance.now() - focusAnim.t0) / FOCUS_MS);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
    view.zoomY = focusAnim.z0 * Math.pow(focusAnim.z1 / focusAnim.z0, e);
    const center = focusAnim.c0 + (focusAnim.c1 - focusAnim.c0) * e;
    view.scrollY = center - view.height / 2 / view.zoomY;
    invalidate();
    if (t < 1) focusRaf = requestAnimationFrame(focusTick);
    else focusAnim = null;
  }

  function fit() {
    const { min, max } = source.extent();
    const span = Math.max(1e-9, max - min);
    view.zoomY = view.height > 0 ? view.height / span : 1;
    view.scrollY = min;
    fitted = true;
  }

  // ── render loop ─────────────────────────────────────────────────────────
  let raf = 0;
  function invalidate() {
    if (raf) return;
    raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    if (view.width === 0 || view.height === 0) return;
    if (!fitted) fit();
    clampScroll(view, source.extent(), view.height * 0.5);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, view.width, view.height);

    const env: LaneEnv = {
      theme,
      rule,
      size: { width: view.width, height: view.height },
      lodStep: lodStep(view, rule),
    };
    source.draw(ctx, view, env);
    if (pointerInside && pointerY != null) drawZoomCenter(pointerY);

    updateDebug();
    opts.onFrame?.(view);
  }

  // Visualize the zoom center: a faint dotted line at the raw cursor, a solid
  // line + ring at the gravity-snapped anchor. When snapped onto a target, a
  // lock ring + connector show the pull — so the gravity is legible.
  function drawZoomCenter(rawY: number) {
    const anchor = zoomAnchor(rawY);
    const snapped = Math.abs(anchor - rawY) > 1.5;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(theme.accent, 0.22);
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, rawY + 0.5);
    ctx.lineTo(view.width, rawY + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = withAlpha(theme.accent, snapped ? 0.9 : 0.45);
    ctx.beginPath();
    ctx.moveTo(0, anchor + 0.5);
    ctx.lineTo(view.width, anchor + 0.5);
    ctx.stroke();
    if (snapped) {
      ctx.strokeStyle = withAlpha(theme.accent, 0.45);
      ctx.beginPath(); // connector cursor → snapped anchor
      ctx.moveTo(12, rawY);
      ctx.lineTo(12, anchor);
      ctx.stroke();
      ctx.strokeStyle = withAlpha(theme.accent, 0.6);
      ctx.beginPath(); // lock ring
      ctx.arc(12, anchor, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(12, anchor, snapped ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = withAlpha(theme.accent, 0.9);
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(snapped ? "⊕ zoom · snapped" : "⊕ zoom", 24, anchor - 4);
    ctx.restore();
  }

  function updateDebug() {
    if (!debug) return;
    const extra = source.hudLine?.(view);
    const zpx = view.zoomY;
    debug.innerHTML =
      `<span class="dim">src</span> ${source.title}\n` +
      `<span class="dim">zoom</span> <span class="hi">${zpx.toFixed(zpx < 1 ? 3 : 1)}</span> px/unit\n` +
      `<span class="dim">span</span> ${visibleSpan(view).toFixed(1)} units\n` +
      `<span class="dim">top</span> ${view.scrollY.toFixed(1)}` +
      (extra ? `\n<span class="dim">at</span> ${extra}` : "");
  }

  // ── sizing ──────────────────────────────────────────────────────────────
  // canvas-relative pointer coords (robust vs the flaky offsetX/Y on synthetic
  // events); refreshed on resize/scroll
  let rectLeft = 0;
  let rectTop = 0;
  function refreshRect() {
    const r = canvas.getBoundingClientRect();
    rectLeft = r.left;
    rectTop = r.top;
  }
  const localX = (e: { clientX: number }) => e.clientX - rectLeft;
  const localY = (e: { clientY: number }) => e.clientY - rectTop;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr ?? Infinity);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    view.width = w;
    view.height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    refreshRect();
    if (!fitted) fit();
    invalidate();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  window.addEventListener("scroll", refreshRect, { passive: true });

  // hover position → zoom-center visualization
  let pointerY: number | null = null;
  let pointerInside = false;

  // ── input ───────────────────────────────────────────────────────────────
  const WHEEL_LINE_PX = 16;
  function wheelDeltaPx(e: WheelEvent): number {
    return e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
  }
  // velocity-adaptive zoom: slow scroll stays precise; a fast flick accelerates
  // super-linearly (φ^speed on the exponent) so you can cross many scales fast
  const PHI = 1.618033988749895;
  const WHEEL_BASE = 0.0032; // base exponent gain (a touch faster than before)
  let wheelVel = 0; // EMA of |delta| px per ms
  let lastWheelT = 0;
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    focusAnim = null; // user took over
    pointerY = localY(e);
    pointerInside = true;
    const dPx = wheelDeltaPx(e);
    if (e.ctrlKey || e.metaKey) {
      const now = performance.now();
      const dt = Math.min(200, Math.max(8, now - lastWheelT));
      lastWheelT = now;
      wheelVel = wheelVel * 0.6 + (Math.abs(dPx) / dt) * 0.4; // px/ms, smoothed
      // 0 while zooming slowly (<~0.25 px/ms) → precise; grows when fast
      const s = Math.max(0, (wheelVel - 0.25) / 0.9);
      const accel = Math.pow(PHI, Math.min(s, 6)); // φ^speed, capped
      zoomAt(view, Math.exp(-dPx * WHEEL_BASE * accel), zoomAnchor(pointerY), zoomLimits());
    } else {
      view.scrollY += dPx / view.zoomY;
    }
    invalidate();
  }

  // pointer drag + 2-pointer pinch (touch / trackpad)
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchPrev: { dist: number; midY: number } | null = null;
  function onPointerDown(e: PointerEvent) {
    focusAnim = null; // user took over
    pointers.set(e.pointerId, { x: localX(e), y: localY(e) });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointers (e2e) can't be captured — safe to ignore
    }
    if (pointers.size === 2) pinchPrev = pinchState();
  }
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return {
      dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      midY: (a!.y + b!.y) / 2,
    };
  }
  function onPointerMove(e: PointerEvent) {
    pointerY = localY(e); // hover → zoom-center marker
    pointerInside = true;
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      invalidate(); // just a hover; redraw the marker
      return;
    }
    const now = { x: localX(e), y: localY(e) };
    pointers.set(e.pointerId, now);
    if (pointers.size >= 2) {
      const cur = pinchState();
      if (pinchPrev && cur.dist > 0 && pinchPrev.dist > 0) {
        zoomAt(view, cur.dist / pinchPrev.dist, cur.midY, zoomLimits());
        view.scrollY -= (cur.midY - pinchPrev.midY) / view.zoomY;
      }
      pinchPrev = cur;
    } else {
      // single-pointer drag → move the content (drag down = scroll up)
      view.scrollY -= (now.y - prev.y) / view.zoomY;
    }
    invalidate();
  }
  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchPrev = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }
  function onPointerLeave() {
    pointerInside = false;
    pointerY = null;
    invalidate();
  }
  function onDblClick(e: MouseEvent) {
    const f = source.focusAt?.(localY(e), view);
    if (f) focusTo(f.center, f.zoom);
  }

  // ── keyboard: CapsLockX AccModel — R/F zoom, W/S (+ ↑/↓) scroll ──────────
  // Same physics as the infinite-canvas viewer: acceleration is a function of
  // how long a key is HELD, integrated per frame. One model drives scroll
  // (vertical axis) and one drives zoom (vertical axis, mapped to a factor).
  const ZOOM_SENS = 0.0011; // matches src/rgui.ts
  const kbEnabled = opts.keyboard ?? true;
  const scrollModel = new AccModel2D(opts.keyboardSpeed?.scroll ?? 1600);
  const zoomModel = new AccModel2D(opts.keyboardSpeed?.zoom ?? 1600);
  let navRaf = 0;
  function navTick() {
    navRaf = 0;
    const now = performance.now();
    const s = scrollModel.tick(now);
    const z = zoomModel.tick(now);
    if (z.dy) {
      // R = pressUp ⇒ dy<0 ⇒ zoom in, about the cursor's snapped anchor (the
      // ⊕ marker) when hovering, else the viewport centre
      const anchorY = pointerInside && pointerY != null ? pointerY : view.height / 2;
      zoomAt(view, Math.exp(-z.dy * ZOOM_SENS), zoomAnchor(anchorY), zoomLimits());
    }
    if (s.dy) view.scrollY += s.dy / view.zoomY; // px → world units
    if (s.dy || z.dy) invalidate();
    if (s.active || z.active) navRaf = requestAnimationFrame(navTick);
  }
  const navKick = () => {
    if (!navRaf) navRaf = requestAnimationFrame(navTick);
  };

  function typingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    const tag = el?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable === true;
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!kbEnabled || typingTarget(e.target) || e.repeat) return;
    // never shadow a modifier chord (Cmd/Ctrl+R = reload, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    focusAnim = null; // user took over
    const now = performance.now();
    switch (e.key.toLowerCase()) {
      case "r": // zoom in
        zoomModel.pressUp(now);
        break;
      case "f": // zoom out
        zoomModel.pressDown(now);
        break;
      case "w":
      case "arrowup": // scroll toward the top (earlier / now)
        scrollModel.pressUp(now);
        break;
      case "s":
      case "arrowdown": // scroll toward the bottom (deeper / past)
        scrollModel.pressDown(now);
        break;
      default:
        return;
    }
    e.preventDefault();
    navKick();
  }
  function onKeyUp(e: KeyboardEvent) {
    if (!kbEnabled) return;
    switch (e.key.toLowerCase()) {
      case "r":
        zoomModel.releaseUp();
        break;
      case "f":
        zoomModel.releaseDown();
        break;
      case "w":
      case "arrowup":
        scrollModel.releaseUp();
        break;
      case "s":
      case "arrowdown":
        scrollModel.releaseDown();
        break;
    }
  }

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("dblclick", onDblClick);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return {
    view,
    invalidate,
    fit() {
      fit();
      invalidate();
    },
    setSource(next) {
      source = next;
      fitted = false;
      invalidate();
    },
    setTheme(next) {
      theme = resolveTheme(next);
      invalidate();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (navRaf) cancelAnimationFrame(navRaf);
      if (focusRaf) cancelAnimationFrame(focusRaf);
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("scroll", refreshRect);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    },
  };
}

export { DEFAULT_RULE };
