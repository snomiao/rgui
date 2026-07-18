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
  /** changed-line stats — present only via the GraphQL (token) fetcher */
  stats?: { additions: number; deletions: number };
};

// ── GraphQL (token-mode) fetcher pieces ───────────────────────────────────
// REST's commit list has no line stats; fetching them per commit would cost
// one request each. GraphQL returns a history page WITH additions/deletions
// in a single query — but always requires auth, so this path lights up only
// when the host passes graphql: true (i.e. a token is installed).
const GQL_URL = "https://api.github.com/graphql";
const GQL_QUERY =
  "query($owner:String!,$name:String!,$since:GitTimestamp!,$until:GitTimestamp!,$cursor:String){" +
  "repository(owner:$owner,name:$name){defaultBranchRef{target{... on Commit{" +
  "history(since:$since,until:$until,first:100,after:$cursor){" +
  "pageInfo{hasNextPage endCursor}" +
  "nodes{oid message additions deletions committedDate author{name user{login}}}" +
  "}}}}}}";

/** normalize a GraphQL history response to REST-shaped rows + a next cursor */
export function gqlRows(data: unknown): { rows: GhCommit[]; next: string | null } {
  const h = (
    data as {
      data?: {
        repository?: {
          defaultBranchRef?: {
            target?: {
              history?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                nodes?: Array<{
                  oid: string;
                  message?: string;
                  additions?: number;
                  deletions?: number;
                  committedDate?: string;
                  author?: { name?: string; user?: { login?: string } | null } | null;
                }>;
              };
            };
          };
        };
      };
    }
  )?.data?.repository?.defaultBranchRef?.target?.history;
  if (!h?.nodes) return { rows: [], next: null };
  return {
    rows: h.nodes.flatMap((n) =>
      n?.oid && n.committedDate
        ? [
            {
              sha: n.oid,
              commit: {
                message: n.message ?? "",
                author: { name: n.author?.name, date: n.committedDate },
              },
              author: n.author?.user?.login ? { login: n.author.user.login } : null,
              stats: { additions: n.additions ?? 0, deletions: n.deletions ?? 0 },
            },
          ]
        : [],
    ),
    next: h.pageInfo?.hasNextPage ? (h.pageInfo.endCursor ?? null) : null,
  };
}

// ── localStorage response cache ───────────────────────────────────────────
// Closed history windows are immutable — commits in the past don't change —
// so reloads must not re-spend the 60/h rate limit on them. Only the window
// touching "now" stays fresh via a short TTL. Rows are pruned to the fields
// the view reads (the full message keeps its trailers); quota overflow
// flushes the whole cache and retries once.
const CACHE_PREFIX = "ghc:";
const FRESH_TTL_MS = 10 * 60_000;
const CLOSED_AGE_MS = 60 * 60_000; // a window this far behind now can't change
const YEAR_MS = 31556952000;
function pruneRows(rows: GhCommit[]): GhCommit[] {
  return rows.map((c) => ({
    sha: c.sha,
    commit: {
      message: String(c.commit?.message ?? ""),
      author: c.commit?.author
        ? { name: c.commit.author.name, date: c.commit.author.date }
        : null,
    },
    author: c.author?.login ? { login: c.author.login } : null,
    ...(c.stats ? { stats: c.stats } : {}),
  }));
}
type CacheHit = { rows: GhCommit[]; next: string | null };
function cacheGet(key: string, untilMs: number): CacheHit | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, rows, next } = JSON.parse(raw) as {
      t: number;
      rows: GhCommit[];
      next?: string | null;
    };
    const closed = untilMs < Date.now() - CLOSED_AGE_MS;
    if (!closed && Date.now() - t > FRESH_TTL_MS) return null;
    return Array.isArray(rows) ? { rows, next: next ?? null } : null;
  } catch {
    return null;
  }
}
/** size of the on-disk git-history cache (shown in the debug panel) */
export function gitCacheStats(): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(CACHE_PREFIX)) continue;
      entries++;
      bytes += k.length + (localStorage.getItem(k)?.length ?? 0);
    }
  } catch {
    /* storage unavailable */
  }
  return { entries, bytes };
}
function cachePut(key: string, rows: GhCommit[], next: string | null) {
  const entry = JSON.stringify({ t: Date.now(), rows: pruneRows(rows), next });
  try {
    localStorage.setItem(CACHE_PREFIX + key, entry);
  } catch {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(CACHE_PREFIX + key, entry);
    } catch {
      /* still over quota — live without the cache */
    }
  }
}

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
    // changed lines (GraphQL mode) sharpen importance: a 2k-line feat commit
    // keeps its label at zooms where a one-liner has faded to a dot
    const lines = c.stats ? c.stats.additions + c.stats.deletions : null;
    const imp =
      lines == null
        ? commitImp(subject)
        : Math.min(0.9, commitImp(subject) + Math.log2(1 + lines) / 50);
    const sized = c.stats ? ` · +${c.stats.additions} −${c.stats.deletions}` : "";
    return [
      {
        y: api.ybpOfMs(tMs),
        tMs,
        precision: { kind: "calendar", unit: "minute" } as const,
        label: subject,
        detail: `${repo} · ${author}${sized}`,
        imp,
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
  // ≈1.4-day minimum cell: one page chain (4 × 100 commits) per cell is the
  // coverage unit, so the floor bounds how dense a repo can be before sampling
  // starts — the old 11-day floor showed only the newest 100 of ~2.5k linux
  // commits per cell. linux ≈ 300 commits/1.4d, within one chain.
  let size = 1 / 256;
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
  /**
   * how many 100-commit pages a full window may chain (default 4). With an
   * auth token (5,000 req/h vs 60) the host can afford a deeper chain.
   */
  pageCap?: number;
  /**
   * use the GraphQL API (requires the host to inject an auth header for
   * api.github.com): same windows and caching, but each commit arrives with
   * changed-line stats that feed importance and the detail line.
   */
  graphql?: boolean;
}

export function createGitHistorySource(
  opts: GitHistoryOptions = {},
): TimelineSource {
  const repos = opts.repos ?? ["snomiao/rgui"];
  const pageCap = opts.pageCap ?? 4;
  const seen = new Set<string>(); // commit shas already ingested
  const usedKeys = new Set<string>(); // cell pages already served (cache or net)

  const tracks: CatMeta[] = repos.map((repo, i) => ({
    cat: repo,
    label: repo.split("/")[1] ?? repo,
    color: REPO_COLORS[i % REPO_COLORS.length]!,
  }));

  // fetch one page of a cell; a FULL page means the cell has more history —
  // chain the next page (GitHub serves newest-first within since/until), so a
  // busy repo like linux fills in beyond the first 100 instead of silently
  // sampling. pageCap bounds the chain: unauthenticated GitHub allows only
  // 60 req/h, so exhaustive history is not on the table — the cap trades
  // completeness for staying usable across zooms. Cached cells (see the
  // localStorage cache above) are served without touching the network.
  // `cursor` is the GraphQL continuation from the PREVIOUS page (REST pages
  // by number instead); either way the cache stores each page's continuation
  // so a cached chain replays without any network.
  function fetchCell(
    repo: string,
    cell: { top: number; bot: number },
    api: TimelineFetchApi,
    page: number,
    cursor?: string,
  ) {
    const mode = opts.graphql ? "gql" : "gh";
    const key = `${mode}:${repo}:${cell.bot.toPrecision(6)}:${cell.top.toPrecision(6)}:p${page}`;
    if (usedKeys.has(key)) return;
    const untilMs = Date.now() - cell.bot * YEAR_MS;
    const chain = (next: string | null) => {
      if (next && page < pageCap)
        fetchCell(repo, cell, api, page + 1, next === "rest" ? undefined : next);
    };
    const cached = cacheGet(key, untilMs);
    if (cached) {
      usedKeys.add(key);
      api.ingest(commitEvents(cached.rows, repo, api, seen));
      chain(cached.next);
      return;
    }
    if (opts.graphql) {
      const [owner, name] = repo.split("/");
      api.lazyFetch(
        key,
        GQL_URL,
        (data) => {
          const { rows, next } = gqlRows(data);
          if (!rows.length && !(data as { data?: unknown })?.data) return []; // auth/error body
          usedKeys.add(key);
          cachePut(key, rows, next);
          chain(next);
          return commitEvents(rows, repo, api, seen);
        },
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: GQL_QUERY,
            variables: {
              owner,
              name,
              since: api.isoOf(cell.top),
              until: api.isoOf(cell.bot),
              cursor: cursor ?? null,
            },
          }),
        },
      );
      return;
    }
    api.lazyFetch(
      key,
      `https://api.github.com/repos/${repo}/commits?since=${api.isoOf(cell.top)}&until=${api.isoOf(cell.bot)}&per_page=100&page=${page}`,
      (data) => {
        if (!Array.isArray(data)) return []; // rate-limited / error body
        usedKeys.add(key);
        const next = data.length === 100 ? "rest" : null;
        cachePut(key, data as GhCommit[], next);
        chain(next);
        return commitEvents(data as GhCommit[], repo, api, seen);
      },
    );
  }

  function fetchCommits(view: LaneView, api: TimelineFetchApi) {
    const { top, bot } = api.winYBP(view);
    if (bot > GIT_ERA) return; // whole window predates the repos
    for (const cell of windowCells(Math.min(top, GIT_ERA), bot)) {
      for (const repo of repos) {
        if (!api.enabled(repo)) continue; // toggled-off repos don't fetch
        fetchCell(repo, cell, api, 1);
      }
    }
  }

  const dataset: TimelineDataset = {
    title: "git history",
    tracks,
    statics: [],
    oldestYBP: GIT_ERA,
    futureYears: 7 * DAY,
    // open on the recent weeks — the whole era stays reachable by scrolling
    fitYBP: { top: 45 * DAY, bot: -2 * DAY },
    fetch: fetchCommits,
  };
  // linear axis by default: git history is a human-scale linear record —
  // symlog's decade compression just crams it against "now" (taku). The
  // toolbar's axis button still offers log.
  return createTimelineSource({ logAxis: false, dataset });
}
