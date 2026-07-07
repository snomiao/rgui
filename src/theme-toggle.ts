/**
 * Homepage theme toggle — three states: auto (default) → light → dark.
 * Auto follows the OS LIVE: no stored choice, and a prefers-color-scheme
 * change flips the page while it's open. An explicit choice persists in
 * localStorage; picking auto clears it.
 * One switch drives both halves of the page: the CSS variables
 * (html[data-theme]) for DOM chrome, and viewer.setTheme() for everything
 * painted on the rgui canvas. First paint is handled by the inline script
 * in index.html (same rules, before CSS applies — no flash).
 */

const KEY = "rgui-theme";
type Mode = "dark" | "light";
type Choice = Mode | "auto";

type ViewerLike = { setTheme?: (t: Mode) => void };
const viewer = () => (window as unknown as { viewer?: ViewerLike }).viewer;

const mq = matchMedia("(prefers-color-scheme: light)");
const saved = localStorage.getItem(KEY);
let choice: Choice = saved === "light" || saved === "dark" ? saved : "auto";
const effective = (): Mode =>
  choice === "auto" ? (mq.matches ? "light" : "dark") : choice;

const ICON: Record<Choice, string> = { auto: "◐", light: "☀", dark: "☾" };

const btn = document.createElement("button");
btn.id = "theme-toggle";
btn.type = "button";

function apply() {
  const mode = effective();
  document.documentElement.dataset.theme = mode;
  if (choice === "auto") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  btn.textContent = ICON[choice];
  btn.title =
    choice === "auto"
      ? `theme: auto (system → ${mode}) — click to switch`
      : `theme: ${choice} — click to switch`;
  btn.setAttribute("aria-label", btn.title);
  viewer()?.setTheme?.(mode);
}

btn.addEventListener("click", () => {
  choice = choice === "auto" ? "light" : choice === "light" ? "dark" : "auto";
  apply();
});
// auto = live: follow an OS theme change while the page is open
mq.addEventListener("change", () => {
  if (choice === "auto") apply();
});
document.body.appendChild(btn);
apply();

// the viewer mounts async — re-apply once so the canvas matches the page
const sync = () => {
  if (viewer()?.setTheme) viewer()!.setTheme!(effective());
  else setTimeout(sync, 200);
};
sync();
