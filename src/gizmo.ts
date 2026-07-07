/**
 * Homepage gizmo wiring — drag the corner block-spin cube to rotate the
 * whole rgui viewport (CAD-viewcube style). Angular drag: the rotation
 * delta equals the pointer's angle swept around the cube's center, so the
 * cube feels like a physical rotation handle. Double-click resets to 0.
 *
 * Non-invasive: attaches listeners to the #hero-cube widget created by
 * cube.ts and drives window.viewer.setRotation(); touches nothing else.
 */
type ViewerLike = {
  rotation: number;
  setRotation(rad: number, opts?: { animate?: boolean }): void;
};

function attach() {
  const wrap = document.getElementById("hero-cube");
  const viewer = (window as unknown as { viewer?: ViewerLike }).viewer;
  if (!wrap || !viewer?.setRotation) {
    setTimeout(attach, 200); // cube.ts / viewer not mounted yet
    return;
  }
  const cv = wrap.querySelector("canvas");
  if (!cv) return;

  wrap.style.pointerEvents = "auto";
  cv.style.cursor = "grab";
  cv.title = "drag to rotate the canvas · double-click to reset";

  let drag: { startAngle: number; baseRotation: number } | null = null;

  const pointerAngle = (ev: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    return Math.atan2(
      ev.clientY - (r.top + r.height / 2),
      ev.clientX - (r.left + r.width / 2),
    );
  };

  cv.addEventListener("pointerdown", (ev) => {
    drag = {
      startAngle: pointerAngle(ev),
      baseRotation: viewer.rotation,
    };
    cv.setPointerCapture(ev.pointerId);
    cv.style.cursor = "grabbing";
    ev.preventDefault();
  });
  cv.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const delta = pointerAngle(ev) - drag.startAngle;
    viewer.setRotation(drag.baseRotation + delta, { animate: false });
  });
  const end = () => {
    drag = null;
    cv.style.cursor = "grab";
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("dblclick", () => viewer.setRotation(0));
}

attach();
