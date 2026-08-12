/**
 * rgui lane — the engine for limited-visual-width / vertical-zoom rendering.
 *
 * `createLane(canvas, { source })` owns the {@link LaneView}, a dpr-aware
 * Canvas-2D render loop, and all input (vertical scroll or drag = move,
 * horizontal scroll, horizontal drag or pinch = zoom, R/F zoom, W/S move). It is deliberately dataset-blind:
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
  /** canvas-local pointer, or null when it is outside. Lets a source hover-
   *  highlight what it drew without the host re-deriving hit geometry. */
  pointer: { x: number; y: number } | null;
  /** px of the canvas top covered by the host's own chrome. The chart still
   *  paints full-bleed underneath; only TEXT the reader must be able to read
   *  (sticky headers, axis labels) is pushed below it. */
  safeTop: number;
}

/** a 1-D dataset the lane can render. World coords run along the flow axis. */
export interface LaneSource {
  /** short label (shown in the debug HUD) */
  title: string;
  /** flow-axis world bounds, for scroll clamping */
  extent(): { min: number; max: number };
  /**
   * bounds the initial auto-fit frames (default: extent). Lets a source bias
   * the default view — e.g. the deep-time lane fits the PAST, leaving the
   * sparse far-future reachable by scrolling within the full extent.
   */
  fitExtent?(): { min: number; max: number };
  /** draw the currently visible window; width is pinned, so lay x out in px */
  draw(ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv): void;
  /**
   * comfortable max zoom (px per world unit). Default 240 — one world unit can
   * grow to a large-but-finite row. Sources with tiny units may raise it.
   */
  maxZoom?: number;
  /** extra HUD line (e.g. hovered path / value under the cursor) */
  hudLine?: (view: LaneView, pointerY?: number) => string | null;
  /**
   * notable points the zoom anchor gravitates toward: world-y plus an optional
   * screen-x (e.g. a track centre). When the cursor is near one, zooming keeps
   * THAT point fixed (so a not-quite-aimed target doesn't drift off-screen);
   * far from any, plain cursor zoom. With x, the pull is track-aware — an event
   * in the hovered track wins over an equally-timed event in another track. The
   * pull is a smooth gaussian, not a hard snap.
   */
  snapTargets?: (view: LaneView) => { y: number; x?: number }[];
  /**
   * double-click focus: given the click's screen-y, return the world center to
   * scroll to and the zoom to scale to (the target's natural scale), or null.
   */
  focusAt?: (screenY: number, view: LaneView) => { center: number; zoom: number } | null;
  /**
   * how empty the current viewport is (0 = dense, 1 = void). Scrolling into
   * emptiness auto-zooms-out proportionally (rate = scroll-speed × emptiness),
   * so the UI never dwells on a silly blank stretch. Omit → no auto-zoom.
   */
  emptiness?: (view: LaneView) => number;
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
  /**
   * the zoom-center indicator (dotted cursor line + snapped-anchor ring).
   * Default true; hosts with their own pointer affordances (e.g. the
   * calendar's crosshair + cell highlight) turn it off.
   */
  zoomIndicator?: boolean;
  /**
   * px of the canvas top hidden behind the host's floating chrome (toolbars,
   * chips). Sources push their sticky header/axis labels below it so the two
   * never overlap, while the chart keeps rendering edge to edge. A function is
   * re-read every frame — right for a toolbar that rewraps on resize.
   */
  safeTop?: number | (() => number);
  onFrame?: (view: LaneView) => void;
}

export interface Lane {
  readonly view: LaneView;
  invalidate(): void;
  setSource(source: LaneSource): void;
  setTheme(theme: RgThemeInput): void;
  /** re-fit the whole extent into the viewport */
  fit(): void;
  /** restore an explicit view (won't be clobbered by auto-fit) */
  setView(v: { scrollY?: number; zoomY?: number }): void;
  /** animate to a focus target (center world-y + zoom), like double-click */
  focus(target: { center: number; zoom: number }): void;
  /** true while a focus() animation is in flight (hosts gate view rewrites) */
  isAnimating(): boolean;
  /** enable/disable scroll-into-emptiness auto-zoom-out (default OFF) */
  setAutoZoomOut(on: boolean): void;
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
  const SNAP_SIGMA = 84; // px capture radius (wide)
  const SNAP_BOOST = 1.8; // >1 → a full-snap plateau near the core, smooth edges
  function zoomAnchor(rawScreenY: number): number {
    const targets = source.snapTargets?.(view);
    if (!targets || !targets.length) return rawScreenY;
    // pick the target nearest in 2-D (dy² + dx²): x makes it track-aware, so an
    // event under the hovered track beats an equally-timed one elsewhere
    let bestTy = rawScreenY;
    let bestD2 = Infinity;
    for (const t of targets) {
      const ty = worldToScreenY(view, t.y);
      const dy = ty - rawScreenY;
      const dx = t.x != null && pointerX != null ? t.x - pointerX : 0;
      const d2 = dy * dy + dx * dx;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestTy = ty;
      }
    }
    // boosted gaussian: ≈1 (full lock) across the core, still eases at the edge
    const g = Math.min(1, SNAP_BOOST * Math.exp(-bestD2 / (SNAP_SIGMA * SNAP_SIGMA)));
    return rawScreenY + g * (bestTy - rawScreenY);
  }

  // Scrolling into empty space auto-zooms-out: rate ∝ scroll speed × emptiness.
  // Self-limiting — zooming out reveals more content, emptiness drops, it eases.
  // OFF by default (an opt-in preference): the surprise zoom fought users more
  // than the blank stretches did.
  const EMPTY_K = 0.0012;
  let autoZoomOut = false;
  function scrollDamp(dScreenPx: number) {
    if (!autoZoomOut) return;
    const emp = source.emptiness?.(view) ?? 0;
    if (emp <= 0.02) return;
    zoomAt(
      view,
      Math.exp(-EMPTY_K * Math.abs(dScreenPx) * emp),
      view.height / 2,
      zoomLimits(),
    );
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
    const { min, max } = source.fitExtent?.() ?? source.extent();
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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, view.width, view.height);

    const env: LaneEnv = {
      theme,
      rule,
      size: { width: view.width, height: view.height },
      lodStep: lodStep(view, rule),
      pointer: pointerInside && pointerX != null && pointerY != null
        ? { x: pointerX, y: pointerY }
        : null,
      safeTop: Math.max(
        0,
        Math.min(
          view.height / 3, // never let chrome claim the whole viewport
          (typeof opts.safeTop === "function" ? opts.safeTop() : opts.safeTop) ?? 0,
        ),
      ),
    };
    source.draw(ctx, view, env);
    if ((opts.zoomIndicator ?? true) && pointerInside && pointerY != null)
      drawZoomCenter(pointerY);

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
    const extra = source.hudLine?.(
      view,
      pointerInside && pointerY != null ? pointerY : undefined,
    );
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

  // hover position → zoom-center visualization + track-aware snap
  let pointerY: number | null = null;
  let pointerX: number | null = null;
  let pointerInside = false;

  // ── input ───────────────────────────────────────────────────────────────
  const WHEEL_LINE_PX = 16;
  function wheelDeltaPx(e: WheelEvent, delta: number): number {
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * WHEEL_LINE_PX;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * view.height;
    return delta;
  }
  // velocity-adaptive zoom: slow scroll stays precise; a fast flick accelerates
  // super-linearly (φ^speed on the exponent) so you can cross many scales fast
  const PHI = 1.618033988749895;
  const WHEEL_BASE = 0.016; // 5× gain for trackpad horizontal-scroll / pinch zoom
  const WHEEL_GESTURE_GAP_MS = 180;
  const WHEEL_DIRECTION_MIN_PX = 0.25;
  const WHEEL_DIRECTION_EMA = 0.35;
  type WheelOperation = "zoom-in" | "scroll-up" | "zoom-out" | "scroll-down";
  let wheelOperation: WheelOperation | null = null;
  let smoothWheelX = 0;
  let smoothWheelY = 0;
  let lastPlainWheelT = -Infinity;
  let wheelVel = 0; // EMA of |delta| px per ms
  let lastWheelT = 0;

  // Screen-space wheel angle: right=0°, up=90°, left=180°, down=270°.
  const wheelAngle = (dx: number, dy: number) =>
    (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360;

  // Horizontal intent follows the trackpad's natural-scroll sense: swiping
  // content LEFT (deltaX > 0, screen angle 0°) pushes the timeline away →
  // zoom OUT; swiping right pulls it closer → zoom IN.
  function nearestWheelOperation(angle: number): WheelOperation {
    if (angle < 45 || angle >= 315) return "zoom-out";
    if (angle < 135) return "scroll-up";
    if (angle < 225) return "zoom-in";
    return "scroll-down";
  }

  // Each operation owns its nearest-axis 90° sector plus a 15° overlap on
  // both sides. The overlap belongs to the CURRENT operation (hysteresis), so
  // boundary noise can never alternate pan and zoom frame by frame.
  function operationHolds(op: WheelOperation, angle: number): boolean {
    switch (op) {
      case "zoom-out": return angle <= 60 || angle >= 300;
      case "scroll-up": return angle >= 30 && angle <= 150;
      case "zoom-in": return angle >= 120 && angle <= 240;
      case "scroll-down": return angle >= 210 && angle <= 330;
    }
  }

  function resetPlainWheelGesture() {
    wheelOperation = null;
    smoothWheelX = 0;
    smoothWheelY = 0;
    lastPlainWheelT = -Infinity;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    focusAnim = null; // user took over
    pointerY = localY(e);
    pointerX = localX(e);
    pointerInside = true;
    const dY = wheelDeltaPx(e, e.deltaY);
    const dX = wheelDeltaPx(e, e.deltaX);
    // A browser trackpad pinch arrives as ctrl/meta + vertical wheel. Plain
    // two-axis vectors go through the four-operation classifier below, while
    // Shift+wheel remains the mouse-wheel fallback for explicit zoom.
    const pinch = e.ctrlKey || e.metaKey;
    const shiftedHorizontal = !pinch && e.shiftKey && dX === 0;
    const now = performance.now();
    let panPx: number;
    let zoomPx: number;
    if (pinch) {
      panPx = 0;
      zoomPx = -dY;
      resetPlainWheelGesture();
    } else if (shiftedHorizontal) {
      panPx = 0;
      zoomPx = dY;
      resetPlainWheelGesture();
    } else {
      const magnitude = Math.hypot(dX, dY);
      if (magnitude < WHEEL_DIRECTION_MIN_PX) {
        invalidate();
        return;
      }
      const ux = dX / magnitude;
      const uy = dY / magnitude;
      const fresh = now - lastPlainWheelT > WHEEL_GESTURE_GAP_MS;
      if (fresh || !wheelOperation) {
        smoothWheelX = ux;
        smoothWheelY = uy;
        wheelOperation = nearestWheelOperation(wheelAngle(ux, uy));
      } else {
        smoothWheelX += (ux - smoothWheelX) * WHEEL_DIRECTION_EMA;
        smoothWheelY += (uy - smoothWheelY) * WHEEL_DIRECTION_EMA;
        const angle = wheelAngle(smoothWheelX, smoothWheelY);
        if (!operationHolds(wheelOperation, angle)) {
          wheelOperation = nearestWheelOperation(angle);
        }
      }
      lastPlainWheelT = now;
      panPx = wheelOperation === "scroll-up"
        ? -magnitude
        : wheelOperation === "scroll-down" ? magnitude : 0;
      zoomPx = wheelOperation === "zoom-in"
        ? magnitude
        : wheelOperation === "zoom-out" ? -magnitude : 0;
    }

    if (zoomPx !== 0) {
      const dt = Math.min(200, Math.max(8, now - lastWheelT));
      lastWheelT = now;
      wheelVel = wheelVel * 0.6 + (Math.abs(zoomPx) / dt) * 0.4; // px/ms, smoothed
      // 0 while zooming slowly (<~0.25 px/ms) → precise; grows when fast
      const s = Math.max(0, (wheelVel - 0.25) / 0.9);
      const accel = Math.pow(PHI, Math.min(s, 6)); // φ^speed, capped
      zoomAt(view, Math.exp(zoomPx * WHEEL_BASE * accel), zoomAnchor(pointerY), zoomLimits());
    }
    if (panPx !== 0) {
      view.scrollY += panPx / view.zoomY;
      scrollDamp(panPx);
    }
    invalidate();
  }

  // pointer drag + 2-pointer pinch (touch / trackpad)
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchPrev: { dist: number; midY: number } | null = null;
  // Single-drag axis lock, the drag counterpart of the wheel classifier: a
  // TOUCH drag is EITHER a move or a zoom, decided once per gesture and held.
  // A vertical drag moves the content (as always); a horizontal one zooms, the
  // same way a horizontal scroll does — on a touchscreen there is no wheel to
  // reach for. Deciding per-frame instead would let a wobbly pan smear the
  // zoom. Mouse/pen drags stay pure moves: hosts build their own drag
  // grammars on them (the calendar drags out new events).
  const DRAG_AXIS_LOCK_PX = 6; // travel before a gesture commits to an axis
  const DRAG_ZOOM_BASE = 0.006; // e^(px·base): a 100px drag ≈ 1.8× — a direct
  // manipulation, so no flick acceleration (that belongs to the wheel)
  let dragStart: { x: number; y: number } | null = null;
  let dragAxis: "move" | "zoom" | null = null;
  function onPointerDown(e: PointerEvent) {
    focusAnim = null; // user took over
    pointers.set(e.pointerId, { x: localX(e), y: localY(e) });
    if (pointers.size === 1 && e.pointerType === "touch") {
      dragStart = { x: localX(e), y: localY(e) };
      dragAxis = null;
    } else {
      dragStart = null; // pinch owns the gesture
      dragAxis = null;
    }
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
    pointerX = localX(e);
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
      const dx = now.x - prev.x;
      const dy = now.y - prev.y;
      if (!dragAxis && dragStart) {
        const ax = now.x - dragStart.x;
        const ay = now.y - dragStart.y;
        if (Math.hypot(ax, ay) >= DRAG_AXIS_LOCK_PX)
          dragAxis = Math.abs(ax) > Math.abs(ay) ? "zoom" : "move";
      }
      if (dragAxis === "zoom") {
        // dragging right pulls the timeline closer (zoom in) — the same sense
        // as swiping a trackpad right
        zoomAt(view, Math.exp(dx * DRAG_ZOOM_BASE), zoomAnchor(now.y), zoomLimits());
      } else {
        // drag down = scroll up
        view.scrollY -= dy / view.zoomY;
        scrollDamp(dy);
      }
    }
    invalidate();
  }
  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchPrev = null;
    if (pointers.size === 0) {
      dragStart = null;
      dragAxis = null;
    }
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
    if (s.dy) {
      view.scrollY += s.dy / view.zoomY; // px → world units
      scrollDamp(s.dy);
    }
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
      case "d": // zoom in (alias)
        zoomModel.pressUp(now);
        break;
      case "f": // zoom out
      case "a": // zoom out (alias)
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
      case "d":
        zoomModel.releaseUp();
        break;
      case "f":
      case "a":
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
    setView(v) {
      if (v.zoomY != null) view.zoomY = v.zoomY;
      if (v.scrollY != null) view.scrollY = v.scrollY;
      fitted = true; // treat as an explicit view; don't auto-fit over it
      focusAnim = null;
      invalidate();
    },
    isAnimating: () => focusAnim !== null,
    setAutoZoomOut(on) {
      autoZoomOut = on;
    },
    focus(target) {
      focusTo(target.center, target.zoom);
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
