/**
 * rgui gantt — the shared gestures, bound to any element and driving a GanttController:
 *   - pan: native scroll (mode "native": el is the scroll container) or the controller's own scroll
 *     (mode "virtual": wheel and drags call panBy; the renderer draws from controller.scrollX/scrollY)
 *   - free 2D touch drag with momentum (freePan; native one-container scrolling locks to one axis on phones)
 *   - mouse drag pans both axes
 *   - zoom: ctrl/⌘+wheel and trackpad pinch, Safari gesture events, two-finger pinch; the time under the
 *     cursor / the fingers' midpoint stays put (log axis included)
 * Returns a function that unbinds everything.
 */
import type { GanttController } from "./core";

export type GanttInputOptions = {
  mode?: "native" | "virtual";
  /** take over one-finger touch drags (touch-action:none) for diagonal pan + momentum (default true) */
  freePan?: boolean;
};

export function bindInput(el: HTMLElement, ctl: GanttController, opts: GanttInputOptions = {}): () => void {
  const native = (opts.mode ?? "native") === "native",
    freePan = opts.freePan ?? true,
    off: (() => void)[] = [];
  const listen = <K extends string>(
    t: EventTarget,
    ev: K,
    fn: (e: any) => void,
    o?: AddEventListenerOptions,
  ) => {
    t.addEventListener(ev, fn, o);
    off.push(() => t.removeEventListener(ev, fn, o));
  };
  let leftAt = -1e9,
    leftV = 0;
  const left = () => {
    const t = performance.now();
    if (t - leftAt > 500) {
      leftAt = t;
      leftV = el.getBoundingClientRect().left;
    }
    return leftV;
  };
  const pan = (dx: number, dy: number) => {
    if (native) {
      el.scrollLeft += dx;
      el.scrollTop += dy;
    } else ctl.panBy(dx, dy);
  };

  if (native) {
    // the element scrolls: tell the controller; when the controller moves (recentre, zoom), move the element
    let syncing = false;
    listen(el, "scroll", () => {
      if (!syncing) ctl.scrollTo(el.scrollLeft, el.scrollTop);
    }, { passive: true });
    off.push(
      ctl.on("view", () => {
        if (Math.abs(el.scrollLeft - ctl.scrollX) < 0.5 && Math.abs(el.scrollTop - ctl.scrollY) < 0.5) return;
        syncing = true;
        el.scrollLeft = ctl.scrollX;
        el.scrollTop = ctl.scrollY;
        syncing = false;
      }),
    );
  }
  if (freePan) el.style.touchAction = "none";

  listen(
    el,
    "wheel",
    (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        ctl.zoomAt(e.clientX - left(), Math.exp(-e.deltaY * 0.01));
      } else if (!native) {
        e.preventDefault();
        pan(e.shiftKey ? e.deltaY : e.deltaX, e.shiftKey ? 0 : e.deltaY);
      }
    },
    { passive: false },
  );
  let g = 1;
  listen(el, "gesturestart", (e) => {
    e.preventDefault();
    g = 1;
  });
  listen(el, "gesturechange", (e) => {
    e.preventDefault();
    ctl.zoomAt(e.clientX - left(), e.scale / g);
    g = e.scale;
  });

  // touch: pinch always; with freePan also one-finger 2D pan + momentum
  let pinch: { d: number; left: number } | undefined,
    tp: { x: number; y: number; t: number; vx: number; vy: number } | undefined,
    fling = 0;
  const two = (e: TouchEvent) => {
    const a = e.touches[0]!,
      b = e.touches[1]!;
    return { x: (a.clientX + b.clientX) / 2, d: Math.abs(a.clientX - b.clientX) };
  };
  listen(
    el,
    "touchstart",
    (e: TouchEvent) => {
      cancelAnimationFrame(fling);
      if (e.touches.length === 2) {
        pinch = { d: two(e).d, left: left() };
        tp = undefined;
      } else if (e.touches.length === 1 && freePan) {
        const t = e.touches[0]!;
        tp = { x: t.clientX, y: t.clientY, t: performance.now(), vx: 0, vy: 0 };
      }
    },
    { passive: true },
  );
  listen(
    el,
    "touchmove",
    (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        const c = two(e);
        if (pinch.d > 10 && c.d > 10) ctl.zoomAt(c.x - pinch.left, c.d / pinch.d);
        pinch.d = c.d;
        return;
      }
      if (!tp || e.touches.length !== 1) return;
      const t = e.touches[0]!,
        now = performance.now(),
        dx = t.clientX - tp.x,
        dy = t.clientY - tp.y,
        dt = Math.max(1, now - tp.t);
      pan(-dx, -dy);
      tp = {
        x: t.clientX,
        y: t.clientY,
        t: now,
        vx: (0.8 * dx) / dt + 0.2 * tp.vx,
        vy: (0.8 * dy) / dt + 0.2 * tp.vy,
      };
    },
    { passive: true },
  );
  listen(
    el,
    "touchend",
    (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = undefined;
      if (!tp || e.touches.length) return;
      let { vx, vy } = tp,
        last = performance.now();
      tp = undefined;
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        pan(-vx * dt, -vy * dt);
        const f = Math.pow(0.995, dt);
        vx *= f;
        vy *= f;
        if (Math.hypot(vx, vy) > 0.02) fling = requestAnimationFrame(step);
      };
      fling = requestAnimationFrame(step);
    },
    { passive: true },
  );
  // mouse drag pans both axes (not from buttons)
  let drag: { x: number; y: number } | undefined;
  listen(el, "pointerdown", (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest?.("button,a,input,select,textarea")) return;
    drag = { x: e.clientX, y: e.clientY };
  });
  listen(window, "pointermove", (e: PointerEvent) => {
    if (!drag) return;
    pan(drag.x - e.clientX, drag.y - e.clientY);
    drag = { x: e.clientX, y: e.clientY };
  });
  listen(window, "pointerup", () => (drag = undefined));
  off.push(() => cancelAnimationFrame(fling));
  return () => off.forEach((f) => f());
}
