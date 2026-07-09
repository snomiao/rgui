/**
 * Homepage hero — cycles the "rgui" backronym expansions with a CRT-flash
 * glitch between each. Pure DOM; no dependency on the rgui library itself so
 * it can't perturb the live demo running underneath.
 */
const EXPANSIONS = [
  "Renormalization Group UI",
  "Readable Grid UI",
  "Reduced Graph UI",
  "Recursive Grouping UI",
  "Resolution-Graded UI",
  "Relevant-Coupling GUI",
  "Respective Grouping UI",
  "Related Graph UI",
  "Rounded Gradation UI",
  "Rounded Gauge UI",
  "Rounded Granularity UI",
  "Roentgenium UI (Rg·111)",
];

const CYCLE_MS = 2500;

const word = document.getElementById("hero-word");
if (word) {
  let i = 0;

  const show = (idx: number) => {
    word.textContent = EXPANSIONS[idx] ?? "";
    // Restart the CSS animation by toggling the class off/on across a reflow.
    word.classList.remove("flash");
    void word.offsetWidth; // force reflow so re-adding replays the keyframes
    word.classList.add("flash");
  };

  show(0);
  setInterval(() => {
    i = (i + 1) % EXPANSIONS.length;
    show(i);
  }, CYCLE_MS);
}
