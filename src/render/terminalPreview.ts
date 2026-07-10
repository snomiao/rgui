/**
 * rgui render — terminal-preview node content.
 *
 * A full-content `GraphNode.draw` hook that renders a node as a miniature
 * TUI/console card: a title bar with a status dot and monospace title, and a
 * dark terminal body showing the newest preview lines bottom-anchored (like a
 * live terminal tail). This is the same visual contract as the agent-yes
 * console's agent nodes, extracted here so any federation consumer renders a
 * `renderHints.preview: { kind: "terminal" }` node identically.
 *
 * The palette is intentionally theme-independent: a terminal reads as a dark
 * surface in both light and dark chrome (matching agent-yes.com/r/).
 */

export interface TerminalPreview {
  kind: "terminal";
  /** title-bar text; falls back to the node title drawn by the host */
  title?: string;
  /** status dot: active | needs_input | stuck | exited | idle | (custom) */
  status?: string;
  /** newest-last body lines; the tail is kept visible when space is short */
  lines?: string[];
}

export const TERMINAL_STATUS_COLOR: Record<string, string> = {
  active: "#3fb950",
  needs_input: "#d29922",
  stuck: "#f85149",
  exited: "#6e7781",
  idle: "#8b949e",
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const BAR_BG = "#161b22";
const BODY_BG = "#0d1117";
const TITLE_FG = "#c9d1d9";
const LINE_FG = "#8b949e";

/** Build a `GraphNode.draw` hook for one terminal preview. */
export function terminalPreviewDraw(
  preview: TerminalPreview,
): (ctx: CanvasRenderingContext2D, rect: { width: number; height: number }, view?: { k: number }) => void {
  return (ctx, rect, view) => {
    const w = rect.width;
    const h = rect.height;
    // px caps scale with zoom so the card stays a readable terminal when the
    // node fills the screen instead of pinning 12px type in a huge dark box
    const z = Math.max(1, view?.k ?? 1);
    const barH = Math.max(14, Math.min(26 * z, h * 0.16));

    // title bar: status dot + monospace title, clipped to the bar
    ctx.fillStyle = BAR_BG;
    ctx.fillRect(0, 0, w, barH);
    ctx.beginPath();
    ctx.arc(barH * 0.55, barH * 0.5, Math.max(2, barH * 0.16), 0, Math.PI * 2);
    ctx.fillStyle = TERMINAL_STATUS_COLOR[preview.status ?? ""] ?? "#8b949e";
    ctx.fill();
    if (preview.title) {
      ctx.fillStyle = TITLE_FG;
      ctx.font = `600 ${Math.max(7, Math.min(14 * z, barH * 0.6))}px ${MONO}`;
      ctx.textBaseline = "middle";
      ctx.save();
      ctx.beginPath();
      ctx.rect(barH, 0, w - barH - 4, barH);
      ctx.clip();
      ctx.fillText(preview.title, barH * 1.05, barH * 0.56);
      ctx.restore();
    }

    // terminal body: newest lines, bottom-anchored like a live tail
    const bodyY = barH;
    const bodyH = h - barH;
    ctx.fillStyle = BODY_BG;
    ctx.fillRect(0, bodyY, w, bodyH);
    const lines = preview.lines ?? [];
    if (!lines.length || bodyH <= 14) return;
    const fs = Math.max(7, Math.min(12 * z, bodyH * 0.11));
    const lineH = fs + 3;
    const pad = Math.max(4, fs * 0.7);
    const fit = Math.max(1, Math.floor((bodyH - pad * 2) / lineH));
    const shown = lines.slice(-fit);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, bodyY, w, bodyH);
    ctx.clip();
    ctx.font = `${fs}px ${MONO}`;
    ctx.textBaseline = "top";
    shown.forEach((ln, i) => {
      ctx.fillStyle = ln.startsWith("$") || ln.startsWith("❯") ? TITLE_FG : LINE_FG;
      ctx.fillText(ln, pad, bodyY + pad + i * lineH);
    });
    ctx.restore();
  };
}
