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
  rotation3: { yaw: number; pitch: number; roll: number };
  setRotation3(
    t: { yaw?: number; pitch?: number; roll?: number },
    opts?: { animate?: boolean },
  ): void;
};

function attach() {
  const wrap = document.getElementById("hero-cube");
  const viewer = (window as unknown as { viewer?: ViewerLike }).viewer;
  if (!wrap || !viewer?.setRotation3) {
    setTimeout(attach, 200); // cube.ts / viewer not mounted yet
    return;
  }
  const cv = wrap.querySelector("canvas");
  if (!cv) return;

  wrap.style.pointerEvents = "auto";
  cv.style.cursor = "grab";
  cv.title = "drag to rotate the canvas · double-click to reset";

  let drag: {
    x0: number;
    y0: number;
    base: { yaw: number; pitch: number; roll: number };
  } | null = null;

  cv.addEventListener("pointerdown", (ev) => {
    drag = { x0: ev.clientX, y0: ev.clientY, base: viewer.rotation3 };
    cv.setPointerCapture(ev.pointerId);
    cv.style.cursor = "grabbing";
    ev.preventDefault();
  });
  cv.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    // trackball-lite: horizontal drag = yaw, vertical = pitch
    const S = 0.012; // rad per px
    viewer.setRotation3(
      {
        yaw: drag.base.yaw + (ev.clientX - drag.x0) * S,
        pitch: drag.base.pitch - (ev.clientY - drag.y0) * S,
      },
      { animate: false },
    );
  });
  const end = () => {
    drag = null;
    cv.style.cursor = "grab";
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("dblclick", () =>
    viewer.setRotation3({ yaw: 0, pitch: 0, roll: 0 }),
  );
}

attach();
