/**
 * rgui lane demo dataset — git commit history of any GitHub repo.
 *
 * A pure history view on the generic timeline engine: one TRACK PER REPO,
 * events are commits pulled lazily from the GitHub API. Point it at several
 * repos and their histories run side by side; the fold ladder turns a busy
 * month into per-repo day/hour heat cells, and zooming into an afternoon
 * spreads it back into readable commit subjects.
 *
 * Commits land at minute precision, so the calendar folds and the adaptive
 * zoom clamp get real dense recent data.
 *
 * Demo-side module: it fetches (GitHub REST). The lane/timeline engine stays
 * I/O-free — everything arrives through the TimelineDataset.fetch hook.
 */
import {
  createTimelineSource,
  type CatMeta,
  type TimelineDataset,
  type TimelineEvent,
  type TimelineFetchApi,
  type TimelineSource,
} from "./timeline.js";
import type { LaneView } from "./view.js";

const DAY = 1 / 365.25; // years
const MIN = DAY / 1440; // years
const GIT_ERA = 3; // years back the fetcher bothers looking

/** track colors, assigned to repos in input order */
const REPO_COLORS = [
  "#60a5fa",
  "#f3820d",
  "#2dd4bf",
  "#f472b6",
  "#ffd21c",
  "#b25ce0",
  "#8b949e",
];

/**
 * Which author lane a commit belongs to, from its message trailers + author.
 * Unused by the history view (history only — no agent tracks) but kept
 * exported: it's the attribution rule an agent-activity consumer would use.
 */
export function commitTrack(message: string, author: string): string {
  const a = author.toLowerCase();
  if (/\[bot\]|semantic-release|github-actions|dependabot/.test(a)) return "bot";
  const m = message.toLowerCase();
  const trailers = m
    .split("\n")
    .filter((l) => l.startsWith("co-authored-by:"))
    .join("\n");
  const hay = trailers || (/\bclaude\b|\bcodex\b/.test(a) ? a : "");
  if (/claude/.test(hay)) return "claude";
  if (/codex|chatgpt|openai/.test(hay)) return "codex";
  if (/copilot|gemini|cursor|devin|aider/.test(hay)) return "other";
  return "human";
}

/** commit importance: releases and features outlive chores as you zoom out */
export function commitImp(subject: string): number {
  if (/^[a-z]+(\(.+\))?!:|breaking change/i.test(subject)) return 0.68;
  if (/^chore\(release\)|^release/i.test(subject)) return 0.45;
  if (/^feat/i.test(subject)) return 0.5;
  if (/^fix/i.test(subject)) return 0.42;
  if (/^merge /i.test(subject)) return 0.28;
  return 0.34;
}

type GhCommit = {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; date: string } | null;
  };
  author?: { login?: string } | null;
};

function commitEvents(
  data: unknown,
  repo: string,
  api: TimelineFetchApi,
  seen: Set<string>,
): TimelineEvent[] {
  return (Array.isArray(data) ? (data as GhCommit[]) : []).flatMap((c) => {
    // window cells at different zoom rungs overlap — the same commit arrives
    // once per cell size unless deduped by sha here
    if (!c?.sha || seen.has(c.sha)) return [];
    seen.add(c.sha);
    const date = c?.commit?.author?.date;
    const tMs = date ? Date.parse(date) : NaN;
    if (!isFinite(tMs)) return [];
    const msg = String(c.commit.message ?? "");
    const subject = (msg.split("\n")[0] ?? "").slice(0, 72);
    const author = c.author?.login ?? c.commit.author?.name ?? "";
    return [
      {
        y: api.ybpOfMs(tMs),
        tMs,
        precision: { kind: "calendar", unit: "minute" } as const,
        label: subject,
        detail: `${repo} · ${author}`,
        imp: commitImp(subject),
        cat: repo,
        // commit timestamps are exact to the minute — a wider span would
        // paint half-day uncertainty bands over precise data at deep zoom
        span: MIN,
      },
    ];
  });
}

/**
 * Quantize a visible window to a power-of-two-year grid so a zoom/pan sweep
 * reuses a handful of cell keys instead of minting one per frame (the
 * deep-time SPARQL feeds learned this the hard way: 100+ requests per zoom
 * animation before quantization). Returns the aligned cells covering the
 * window, oldest first.
 */
export function windowCells(
  topYBP: number,
  botYBP: number,
): Array<{ top: number; bot: number }> {
  let size = 1 / 32; // ≈11 days minimum cell
  while (size < topYBP - botYBP) size *= 2;
  const lo = Math.floor(Math.max(0, botYBP) / size);
  const hi = Math.floor(topYBP / size);
  const cells: Array<{ top: number; bot: number }> = [];
  for (let i = hi; i >= lo && cells.length < 3; i--)
    cells.push({ top: (i + 1) * size, bot: i * size });
  return cells;
}

export interface GitHistoryOptions {
  /** GitHub repos to read, as "owner/name" (default: the rgui repo itself) */
  repos?: string[];
}

export function createGitHistorySource(
  opts: GitHistoryOptions = {},
): TimelineSource {
  const repos = opts.repos ?? ["snomiao/rgui"];
  const seen = new Set<string>(); // commit shas already ingested

  const tracks: CatMeta[] = repos.map((repo, i) => ({
    cat: repo,
    label: repo.split("/")[1] ?? repo,
    color: REPO_COLORS[i % REPO_COLORS.length]!,
  }));

  function fetchCommits(view: LaneView, api: TimelineFetchApi) {
    const { top, bot } = api.winYBP(view);
    if (bot > GIT_ERA) return; // whole window predates the repos
    for (const cell of windowCells(Math.min(top, GIT_ERA), bot)) {
      for (const repo of repos) {
        if (!api.enabled(repo)) continue; // toggled-off repos don't fetch
        api.lazyFetch(
          `gh:${repo}:${cell.bot.toPrecision(6)}:${cell.top.toPrecision(6)}`,
          `https://api.github.com/repos/${repo}/commits?since=${api.isoOf(cell.top)}&until=${api.isoOf(cell.bot)}&per_page=100`,
          (data) => commitEvents(data, repo, api, seen),
        );
      }
    }
  }

  const dataset: TimelineDataset = {
    title: "git history",
    tracks,
    statics: [],
    oldestYBP: GIT_ERA,
    futureYears: 7 * DAY,
    fetch: fetchCommits,
  };
  return createTimelineSource({ logAxis: true, dataset });
}
