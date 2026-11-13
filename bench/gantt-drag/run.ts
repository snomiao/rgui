/**
 * bench/gantt-drag — frame times of the gantt view while dragging and pinching.
 *   bun bench/gantt-drag/run.ts [--n 200,1000,5000] [--v A,B,C,D,E] [--label x]
 * Variants: A = the old pointer-pan view (variants/a.ts); src/gantt/native.ts with
 * B = native scroll + sticky DOM, C = B + virtual rows, D = C + canvas bars,
 * E = D + freePan (own touch pan: free diagonal drag + momentum).
 * Bundles src/gantt/view.ts, serves this folder, and drives headless Chromium
 * (playwright) over CDP: desktop 1440x900 (mouse drag, wheel scroll, ctrl+wheel
 * zoom) and phone 390x844 with 4x CPU throttling (touch drag, vertical swipe,
 * two-finger pinch). Reports median / p95 frame time and dropped frames
 * (frames longer than 1.5 vsyncs, counted as the vsyncs they missed).
 * Run it on a machine that may run headless browsers (not symubu).
 */
import { chromium } from "playwright";
import { join } from "node:path";

const dir = import.meta.dir,
  arg = (k: string, d: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1]! : d;
  },
  Ns = arg("n", "200,1000,5000").split(",").map(Number),
  label = arg("label", "");
const bundle = async (f: string) =>
  (
    await Bun.build({ entrypoints: [join(dir, f)], format: "esm", minify: true })
  ).outputs[0]!.text();
const JS: Record<string, string> = {
  "/a.js": await bundle("variants/a.ts"),
  "/native.js": await bundle("../../src/gantt/native.ts"),
};
const Vs = arg("v", "A,B,C,D,E").split(",");
const srv = Bun.serve({
  port: 0,
  fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (JS[p]) return new Response(JS[p], { headers: { "content-type": "text/javascript" } });
    return new Response(Bun.file(join(dir, "page.html")));
  },
});
type Cfg = { name: string; w: number; h: number; touch: boolean; cpu: number };
const CFGS: Cfg[] = [
  { name: "desktop", w: 1440, h: 900, touch: false, cpu: 1 },
  { name: "phone 4x", w: 390, h: 844, touch: true, cpu: 4 },
];
const browser = await chromium.launch();
const rows: string[] = [];
const wave = (i: number, amp: number) => ((i % 30 < 15 ? i % 15 : 15 - (i % 15)) - 7.5) * amp;
for (const V of Vs)
  for (const N of Ns)
    for (const c of CFGS) {
      const p = await browser.newPage({
        viewport: { width: c.w, height: c.h },
        isMobile: c.touch,
        hasTouch: c.touch,
        deviceScaleFactor: 2,
      });
      const cdp = await p.context().newCDPSession(p);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: c.cpu });
      await p.goto(`${srv.url}?n=${N}&v=${V}`);
      await p.waitForFunction(() => document.title === "ok", null, { timeout: 120000 });
      const first: number = await p.evaluate(() => (window as any).first);
      await p.waitForTimeout(300);
      const x = c.w / 2,
        y = c.h / 2,
        touch = (pts: { x: number; y: number }[], type: string) =>
          cdp.send("Input.dispatchTouchEvent", {
            type,
            touchPoints: pts.map((q, id) => ({ ...q, id })),
          });
      const gestures: Record<string, () => Promise<void>> = c.touch
        ? {
            "drag-x": async () => {
              await touch([{ x, y }], "touchStart");
              for (let i = 1; i <= 90; i++) await touch([{ x: x + wave(i, 10), y }], "touchMove");
              await touch([], "touchEnd");
            },
            "swipe-y": async () => {
              await touch([{ x, y }], "touchStart");
              for (let i = 1; i <= 90; i++) await touch([{ x, y: y + wave(i, 20) }], "touchMove");
              await touch([], "touchEnd");
            },
            diag: async () => {
              await touch([{ x, y }], "touchStart");
              for (let i = 1; i <= 90; i++)
                await touch([{ x: x + wave(i, 10), y: y + wave(i, 16) }], "touchMove");
              await touch([], "touchEnd");
            },
            pinch: async () => {
              await touch(
                [
                  { x: x - 40, y },
                  { x: x + 40, y },
                ],
                "touchStart",
              );
              for (let i = 1; i <= 90; i++) {
                const d = 40 + (wave(i, 6) + 45);
                await touch(
                  [
                    { x: x - d, y },
                    { x: x + d, y },
                  ],
                  "touchMove",
                );
              }
              await touch([], "touchEnd");
            },
          }
        : {
            "drag-x": async () => {
              await p.mouse.move(x, y);
              await p.mouse.down();
              for (let i = 1; i <= 90; i++) await p.mouse.move(x + wave(i, 12), y);
              await p.mouse.up();
            },
            "scroll-y": async () => {
              await p.mouse.move(x, y);
              for (let i = 1; i <= 90; i++) await p.mouse.wheel(0, i % 30 < 15 ? 60 : -60);
            },
            zoom: async () => {
              await p.mouse.move(x, y);
              await p.keyboard.down("Control");
              for (let i = 1; i <= 90; i++) await p.mouse.wheel(0, i % 30 < 15 ? -20 : 20);
              await p.keyboard.up("Control");
            },
          };
      for (const [g, run] of Object.entries(gestures)) {
        await p.evaluate(() => {
          const w = window as any;
          w.fr = [];
          w.go = 1;
          let l = performance.now();
          const f = (t: number) => {
            w.fr.push(t - l);
            l = t;
            if (w.go) requestAnimationFrame(f);
          };
          requestAnimationFrame(f);
        });
        const pos = () =>
          p.evaluate(() => {
            const r = (window as any).g.root;
            return [r.scrollLeft, r.scrollTop, (window as any).g.view.t0];
          });
        const p0 = await pos();
        // diagonal: measured after the first half-wave (both axes should have moved)
        if (g === "diag") {
          await touch([{ x, y }], "touchStart");
          for (let i = 1; i <= 7; i++) await touch([{ x: x - i * 10, y: y - i * 16 }], "touchMove");
          await touch([], "touchEnd");
        }
        const p1 = await pos();
        const both = g === "diag" ? (p1[2] !== p0[2] && p1[1] !== p0[1] ? "yes" : "NO") : "";
        await run();
        await p.waitForTimeout(100);
        const fr: number[] = await p.evaluate(() => {
          const w = window as any;
          w.go = 0;
          return w.fr.slice(1);
        });
        fr.sort((a, b) => a - b);
        const q = (k: number) => fr[Math.min(fr.length - 1, Math.floor(fr.length * k))] ?? 0,
          dropped = fr.reduce((s, t) => s + (t > 25 ? Math.round(t / 16.7) - 1 : 0), 0),
          total = fr.reduce((s, t) => s + t, 0);
        rows.push(
          `| ${label}${V} | ${N} | ${c.name} | ${g} | ${q(0.5).toFixed(1)} | ${q(0.95).toFixed(1)} | ${dropped} | ${((fr.length * 1000) / total).toFixed(0)} | ${first.toFixed(0)} | ${both} |`,
        );
        console.error(rows.at(-1));
      }
      await p.close();
    }
await browser.close();
srv.stop();
console.log(
  "| run | N | device | gesture | median ms | p95 ms | dropped | fps | first render ms | 2D drag |\n|---|---|---|---|---|---|---|---|---|---|\n" +
    rows.join("\n"),
);
