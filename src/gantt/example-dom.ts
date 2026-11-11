/**
 * A custom renderer in plain DOM on the headless core: what a client (e.g. syform) writes to draw the chart its
 * own way. Folding, pan, zoom (ctrl+wheel, pinch), log axis and row order all come from GanttController +
 * bindInput; this file only turns frame() into elements.
 */
import { GanttController, type GanttCoreOptions, type GanttRow } from "./core";
import { bindInput } from "./input";

export function plainGantt(host: HTMLElement, opts: GanttCoreOptions & { onOpen?: (b: GanttRow) => void } = {}) {
  const ctl = new GanttController(opts),
    box = document.createElement("div");
  box.style.cssText = "position:relative;overflow:hidden;width:100%;height:100%;font:12px sans-serif";
  host.appendChild(box);
  if (opts.onOpen) ctl.on("open", (b) => opts.onOpen!(b as GanttRow));
  let raf = 0;
  const draw = () => {
    raf = 0;
    const f = ctl.frame(1),
      out: HTMLElement[] = [];
    const div = (css: string, text = "") => {
      const d = document.createElement("div");
      d.style.cssText = `position:absolute;${css}`;
      d.textContent = text;
      out.push(d);
      return d;
    };
    for (const t of f.ticks) div(`left:${t.x}px;top:0;color:#888`, t.label);
    for (const r of f.rows) {
      const top = r.y + 18,
        b = r.line.bar;
      for (const p of r.parts) {
        const sub = r.line.subLanes ? (f.rowHeight - 6) / r.line.subLanes : f.rowHeight - 6;
        div(
          `left:${p.x}px;width:${p.w}px;top:${top + 3 + (p.k ?? 0) * sub}px;height:${sub}px;background:${p.color};opacity:.35`,
        );
      }
      const name = div(`left:${(r.line.depth ?? 0) * 12}px;top:${top}px;line-height:${f.rowHeight}px`);
      name.textContent = r.line.lane ?? `${r.line.hasKids ? (r.line.folded ? "▸ " : "▾ ") : ""}${b!.name ?? b!.id}`;
      if (b) name.onclick = () => (r.line.hasKids ? ctl.toggle(b.lane, b.id) : ctl.open(b));
      name.dataset.id = b?.id ?? "";
    }
    div(`left:${f.nowX}px;top:0;bottom:0;width:1px;background:red`);
    box.replaceChildren(...out);
  };
  const schedule = () => (raf ||= requestAnimationFrame(draw));
  ctl.on("view", schedule);
  ctl.on("change", schedule);
  const unbind = bindInput(box, ctl, { mode: "virtual" });
  ctl.setViewport(box.clientWidth || 800, (box.clientHeight || 600) - 18);
  return { controller: ctl, draw, destroy: () => (unbind(), box.remove()) };
}
