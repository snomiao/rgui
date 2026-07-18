/**
 * rgui lane demo dataset — agent activity ("what did my agents do?").
 *
 * The first real consumer of the generic timeline engine: tracks are AUTHORS
 * (the human plus each coding agent), events are commits pulled lazily from
 * the GitHub API for a set of repos. Attribution comes from commit trailers —
 * `Co-Authored-By: Claude …` / `…Codex…` — the same convention the agents
 * already stamp on their work, so the demo reads its own provenance.
 *
 * Commits land at minute precision, so the calendar fold ladder and the
 * adaptive zoom clamp get real dense recent data: zoom out and the last month
 * folds into week/day heat cells per agent; zoom in and a single afternoon of
 * pair-work spreads into readable commit subjects.
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

const TRACKS: CatMeta[] = [
  { cat: "human", label: "Human", color: "#ffd21c" },
  { cat: "claude", label: "Claude", color: "#d97757" },
  { cat: "codex", label: "Codex", color: "#10a37f" },
  { cat: "other", label: "Other agents", color: "#60a5fa" },
  { cat: "bot", label: "Bots", color: "#8b949e" },
];

/** which track a commit belongs to, from its message trailers + author */
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
        cat: commitTrack(msg, author),
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

export interface AgentsSourceOptions {
  /** GitHub repos to read, as "owner/name" (default: the rgui repo itself) */
  repos?: string[];
}

export function createAgentsSource(
  opts: AgentsSourceOptions = {},
): TimelineSource {
  const repos = opts.repos ?? ["snomiao/rgui"];
  const seen = new Set<string>(); // commit shas already ingested

  function fetchCommits(view: LaneView, api: TimelineFetchApi) {
    const { top, bot } = api.winYBP(view);
    if (bot > GIT_ERA) return; // whole window predates the repos
    for (const cell of windowCells(Math.min(top, GIT_ERA), bot)) {
      for (const repo of repos) {
        api.lazyFetch(
          `gh:${repo}:${cell.bot.toPrecision(6)}:${cell.top.toPrecision(6)}`,
          `https://api.github.com/repos/${repo}/commits?since=${api.isoOf(cell.top)}&until=${api.isoOf(cell.bot)}&per_page=100`,
          (data) => commitEvents(data, repo, api, seen),
        );
      }
    }
  }

  const dataset: TimelineDataset = {
    title: "agents",
    tracks: TRACKS,
    statics: [],
    oldestYBP: GIT_ERA,
    futureYears: 7 * DAY,
    fetch: fetchCommits,
  };
  return createTimelineSource({ logAxis: true, dataset });
}
