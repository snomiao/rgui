/**
 * Hero title — RGUI as the fish itself, swimming in 3-D.
 *
 * The four characters are billboards (always facing the viewer) threaded
 * along a simulated swim path: R is the head, I is the tail. Each char keeps
 * its segment of the mascot crossover (#7 "dither current": 4-color
 * purple→gold, noise-threshold dither streaming head→tail — the exact math
 * behind assets/rgui-icon-*). Characters are drawn far-to-near, so on-screen
 * overlap follows the true front/back relationship of the body; when the
 * fish turns toward you the letters stack with R (and its eye, living in the
 * hole of the R) on top. Position history makes the body bend through turns.
 * Pure DOM; no dependency on the rgui library.
 */

const PALETTE = ["#3a2ea6", "#9b34bf", "#f3820d", "#ffd21c"] as const;
const RGB = PALETTE.map((h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
});

// ---- pattern rule primitives (same as assets/icon-lab.html) ----
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** tileable value noise: lattice wraps mod (P,Q) so whole-period scrolls loop */
function vnoiseT(x: number, y: number, P: number, Q: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const m = (a: number, p: number) => ((a % p) + p) % p;
  const a = hash2(m(ix, P), m(iy, Q)), b = hash2(m(ix + 1, P), m(iy, Q));
  const c = hash2(m(ix, P), m(iy + 1, Q)), d = hash2(m(ix + 1, P), m(iy + 1, Q));
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
const rampIdx = (t: number, thr: number) => {
  const v = clamp01(t) * 3;
  const i = Math.floor(v);
  return i >= 3 ? 3 : v - i > thr ? i + 1 : i;
};

const WORD = "RGUI";
const CELL = 4; // dither cell size in CSS px
const P = 8, Q = 8; // noise tile periods
const LOOP_MS = 4800; // pattern scroll period (whole-period → seamless)
const BLINK_EVERY = 6200, BLINK_MS = 200;
const CYCLE_MS = 30_000; // one closed lap of the pool — exactly home every cycle
const PERSP = 620; // perspective strength: scale = PERSP/(PERSP - z)

const title = document.querySelector<HTMLElement>("#hero .title");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (title) {
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  title.style.position = "relative";
  // the swim canvas lives in a BEHIND layer (below the graph nodes, above
  // the background) — the h1 stays in #hero purely for layout
  let behind = document.getElementById("title-behind");
  if (!behind) {
    behind = document.createElement("div");
    behind.id = "title-behind";
    behind.style.cssText =
      "position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;";
    document.body.appendChild(behind);
  }
  behind.appendChild(cv);
  const ctx = cv.getContext("2d");

  if (ctx) {
    title.style.background = "none";
    title.style.color = "transparent";
    title.style.textShadow = "none"; // else the static DOM text casts a ghost

    // generous overflow room: the fish needs water around the h1 box
    let w = 0, h = 0, dpr = 1, padX = 0, padY = 0;
    const resize = () => {
      dpr = devicePixelRatio || 1;
      w = title.clientWidth;
      h = title.clientHeight;
      const fs = parseFloat(getComputedStyle(title).fontSize);
      padX = Math.ceil(fs * 0.7);
      padY = Math.ceil(fs * 1.05);
      // absolute placement in the fixed behind-layer, tracking the h1's
      // viewport rect (the h1 stays in #hero purely for layout)
      const r = title.getBoundingClientRect();
      cv.style.cssText =
        `position:absolute;left:${r.left - padX}px;top:${r.top - padY}px;` +
        `width:${w + 2 * padX}px;height:${h + 2 * padY}px;pointer-events:none;`;
      cv.width = Math.max(1, Math.round((w + 2 * padX) * dpr));
      cv.height = Math.max(1, Math.round((h + 2 * padY) * dpr));
    };
    resize();
    new ResizeObserver(resize).observe(title);
    window.addEventListener("resize", resize);

    // ---- per-char offscreen sprites ----
    type Sprite = {
      ch: string;
      cw: number; // glyph box css px
      chh: number;
      sprite: HTMLCanvasElement;
      sctx: CanvasRenderingContext2D;
      cells: HTMLCanvasElement;
      cctx: CanvasRenderingContext2D;
      img?: ImageData; // reused per frame — allocation per frame kills GC
    };
    let sprites: Sprite[] = [];
    let spacings: number[] = []; // center-to-center distance to previous char
    const buildSprites = () => {
      const cs = getComputedStyle(title);
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const meas = document.createElement("canvas").getContext("2d")!;
      meas.font = font;
      sprites = [...WORD].map((ch) => {
        const m = meas.measureText(ch);
        const cw = Math.ceil(m.width) + 8;
        const chh = Math.ceil(
          m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
        ) + 8;
        const sprite = document.createElement("canvas");
        sprite.width = cw * dpr;
        sprite.height = chh * dpr;
        const sctx = sprite.getContext("2d")!;
        const cells = document.createElement("canvas");
        const cctx = cells.getContext("2d")!;
        return { ch, cw, chh, sprite, sctx, cells, cctx };
      });
      spacings = sprites.map((s, i) =>
        i === 0 ? 0 : (sprites[i - 1]!.cw + s.cw) / 2 - 6,
      );
      return font;
    };
    let font = buildSprites();
    new ResizeObserver(() => (font = buildSprites())).observe(title);

    // ---- swim: a CLOSED one-way circuit, not back-and-forth ----
    // The head traces a fixed loop (an ellipse in x–z with organic harmonics,
    // plus a gentle y bob) traversed in one direction: leftward across the
    // front (big, reads RGUI), turning through the camera at the left wall,
    // back rightward along the far side, home in exactly CYCLE_MS.
    // θ starts at π/2 so t=0 is the front-pass reading pose.
    const swimPos = (tSwim: number): [number, number, number] => {
      const th =
        Math.PI / 2 +
        (((tSwim % CYCLE_MS) + CYCLE_MS) % CYCLE_MS) * ((Math.PI * 2) / CYCLE_MS);
      const XA = Math.min(Math.max((w - 320) / 2, 140), 520);
      const YA = padY * 0.3, ZA = 110;
      return [
        XA * (Math.cos(th) + 0.1 * Math.sin(2 * th + 1.3)),
        YA * Math.sin(2 * th + 0.6),
        ZA * (Math.sin(th) + 0.18 * Math.sin(3 * th + 0.8)),
      ];
    };
    let hist: [number, number, number][] = [];

    // zoom-reactive bias (3-D rule: in → purple rush, out → gold recede)
    let bias = 0;
    let kLast: number | null = null;
    const zoomBias = () => {
      const k = (window as unknown as { viewer?: { view?: { k: number } } })
        .viewer?.view?.k;
      if (typeof k !== "number") return 0;
      if (kLast === null) kLast = k;
      const dk = Math.log2(k / kLast);
      kLast = k;
      if (dk > 1e-4) bias = -0.35;
      else if (dk < -1e-4) bias = 0.35;
      else bias *= 0.985;
      return bias;
    };

    // blink (with dev hook)
    let nextBlink = performance.now() + 3000;
    let holdLidUntil = 0;
    (window as unknown as { __rguiBlink?: (holdMs?: number) => void }).__rguiBlink =
      (holdMs = 0) => {
        nextBlink = performance.now();
        holdLidUntil = performance.now() + holdMs;
      };

    /** paint one char sprite: glyph mask filled with its body segment of the pattern */
    const paintSprite = (s: Sprite, i: number, u: number, b: number, lid: number) => {
      const { sctx, cctx, cells, cw, chh } = s;
      const w2 = Math.max(2, Math.ceil(cw / CELL));
      const h2 = Math.max(2, Math.ceil(chh / CELL));
      if (cells.width !== w2 || cells.height !== h2) {
        cells.width = w2;
        cells.height = h2;
      }
      if (!s.img || s.img.width !== w2 || s.img.height !== h2)
        s.img = cctx.createImageData(w2, h2);
      const img = s.img;
      const d = img.data;
      for (let cy = 0; cy < h2; cy++)
        for (let cx = 0; cx < w2; cx++) {
          // body coordinate: char i covers s ∈ [i/4, (i+1)/4] of the crossover
          const local = (cx + cy) / (w2 + h2 - 2);
          const raw = (i + local) / WORD.length;
          const t = 0.12 + clamp01((raw - 0.5) * 1.7 + 0.5) * 0.88 + b;
          // world-ish cell coords so the current flows continuously across chars
          const thr = vnoiseT(
            (cx + i * w2) * 0.5 - P * u,
            cy * 0.5 - Q * u,
            P,
            Q,
          );
          const idx = rampIdx(t, clamp01(thr * 1.3 - 0.15));
          const c = RGB[idx] ?? RGB[0]!;
          const o = (cy * w2 + cx) * 4;
          d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
        }
      cctx.putImageData(img, 0, 0);

      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, cw, chh);
      sctx.globalCompositeOperation = "source-over";
      sctx.font = font;
      sctx.textAlign = "center";
      sctx.textBaseline = "middle";
      sctx.fillStyle = "#fff";
      const m = sctx.measureText(s.ch);
      const yMid =
        chh / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 -
        (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 2 +
        (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 2;
      sctx.fillText(s.ch, cw / 2, yMid);
      sctx.globalCompositeOperation = "source-in";
      sctx.imageSmoothingEnabled = false;
      sctx.drawImage(cells, 0, 0, w2, h2, 0, 0, cw, chh);
      sctx.globalCompositeOperation = "source-over";

      // the eye, in the hole of the R
      if (s.ch === "R") {
        const cap = m.actualBoundingBoxAscent;
        const ex = cw / 2 - m.width / 2 + m.width * 0.44;
        const ey = yMid - cap * 0.7 + cap * 0.0;
        const er = Math.max(3, cap * 0.1);
        sctx.save();
        sctx.translate(ex, ey);
        sctx.scale(1, Math.max(0.08, 1 - 0.94 * lid));
        sctx.fillStyle = PALETTE[3];
        sctx.beginPath();
        sctx.arc(0, 0, er * 1.3, 0, Math.PI * 2);
        sctx.fill();
        sctx.fillStyle = PALETTE[0];
        sctx.beginPath();
        sctx.arc(0, 0, er * 0.9, 0, Math.PI * 2);
        sctx.fill();
        if (lid < 0.5) {
          sctx.fillStyle = "#fff";
          sctx.beginPath();
          sctx.arc(-er * 0.32, -er * 0.32, er * 0.26, 0, Math.PI * 2);
          sctx.fill();
        }
        sctx.restore();
      }
    };

    const draw = (tMs: number, tSwim: number) => {
      if (!w || !h) return;
      const u = reduced ? 0.3 : (tSwim % LOOP_MS) / LOOP_MS;
      const b = reduced ? 0 : zoomBias();

      // --- advance the swim along the circuit ---
      if (hist.length === 0)
        for (let j = 1; j <= 900; j++) hist.push(swimPos(tSwim - j * 16));
      hist.unshift(swimPos(tSwim));
      if (hist.length > 900) hist.length = 900;

      // --- thread chars along the path by arc length ---
      const pos: [number, number, number][] = [];
      let hi = 0, acc = 0;
      let prev = hist[0]!;
      for (let i = 0; i < sprites.length; i++) {
        const target = spacings.slice(0, i + 1).reduce((a, c) => a + c, 0);
        while (acc < target && hi < hist.length - 1) {
          hi++;
          const p2 = hist[hi]!;
          acc += Math.hypot(p2[0] - prev[0], p2[1] - prev[1], p2[2] - prev[2]);
          prev = p2;
        }
        pos.push(hist[Math.min(hi, hist.length - 1)]!);
      }

      // --- blink state (shared) ---
      let lid = 0;
      if (!reduced) {
        if (performance.now() < holdLidUntil) lid = 1;
        else {
          if (tMs >= nextBlink + BLINK_MS) nextBlink += BLINK_EVERY;
          const bt = tMs - nextBlink;
          if (bt >= 0 && bt < BLINK_MS) lid = Math.sin((Math.PI * bt) / BLINK_MS);
        }
      }

      // --- paint sprites, then composite far → near ---
      sprites.forEach((s, i) => paintSprite(s, i, u, b, lid));
      const order = sprites
        .map((_, i) => i)
        .sort((a, bb) => pos[a]![2] - pos[bb]![2]); // ascending z: far first
      const CW = w + 2 * padX, CH = h + 2 * padY;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, CW, CH);
      ctx.imageSmoothingEnabled = true;
      // shadow painted in-canvas (a CSS drop-shadow filter on this element
      // forces continuous re-raster over the animating graph beneath)
      ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      for (const i of order) {
        const p = pos[i]!;
        const f = PERSP / (PERSP - p[2]); // perspective scale
        const sx = CW / 2 + p[0] * f;
        const sy = CH / 2 + p[1] * f;
        const s = sprites[i]!;
        ctx.drawImage(
          s.sprite,
          sx - (s.cw * f) / 2,
          sy - (s.chh * f) / 2,
          s.cw * f,
          s.chh * f,
        );
      }
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    };

    if (reduced) {
      requestAnimationFrame((t) => draw(t, 0)); // home = the reading pose
    } else {
      // ~30 fps is visually identical for the slow dither current, and the
      // swim rests after each lap — perpetual raster of a large layer was
      // measured to cost most of the page's frame budget. The swim clock only
      // advances while awake, and sleep always lands ON a lap boundary, so
      // the fish rests exactly at its home reading pose. Hovering the title
      // sends it out for one more full lap.
      let lastT = 0;
      let swimT = 0;
      let lapTarget = CYCLE_MS; // intro: one full lap, then rest at home
      title.addEventListener("pointerenter", () => {
        lapTarget = (Math.floor(swimT / CYCLE_MS) + 1) * CYCLE_MS;
      });
      const tick = (tMs: number) => {
        const awake = swimT < lapTarget;
        if (awake && tMs - lastT >= 33) {
          swimT = Math.min(swimT + Math.min(tMs - lastT, 66), lapTarget);
          lastT = tMs;
          try {
            draw(tMs, swimT);
          } catch (e) {
            console.error("[rgui title]", e);
          }
        } else if (!awake) {
          lastT = tMs;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }
}
