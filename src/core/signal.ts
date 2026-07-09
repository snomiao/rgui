/**
 * rgui core — the SIGNAL ALGEBRA: what a wire carries, and what happens to it
 * when wires fork (one output → many edges) or converge (many edges → one input).
 *
 * `MergeRule` (aggregate.ts) already answers "how do FIELD VALUES combine when
 * nodes renormalize into a block". This module answers the same question one
 * level down, for the DATA on the ports — and adds the question renormalization
 * never had to ask: what happens on the way OUT.
 *
 * ## Two axes, not one
 *
 * The tempting model is a single axis — "change vs state", where a change is
 * additive and splittable and a state is neither. It is the right intuition and
 * the wrong factorization. Two independent properties hide inside it:
 *
 *   MEASURE (fan-in)  — is `+` meaningful across parallel sources?
 *   FANOUT  (fan-out) — is duplicating this value free, or does it violate a
 *                       conservation law?
 *
 * They come apart in both directions:
 *
 *   - A cumulative counter (`requests = 1523`) is additive across shards, yet on
 *     fan-out it must be COPIED. Two downstream dashboards each see 1523; you do
 *     not hand one of them 700 and the other 823.
 *   - A transfer of 100 coins is additive AND must never be copied — duplicating
 *     it mints money.
 *
 * Physics makes the same distinction and keeps the words apart: mass is extensive
 * and conserved; ENTROPY is extensive and emphatically not conserved; volume is
 * extensive and not conserved either. Additivity and conservation are orthogonal
 * even in the theory the vocabulary is borrowed from.
 *
 * So rgui declares them separately:
 *
 *                │ fanout "copy"                │ fanout "split" / "route"
 *   ─────────────┼──────────────────────────────┼───────────────────────────────
 *   extensive    │ STT transcript segments,     │ token budget, money, work
 *   (sum/concat) │ audio chunks, log lines,     │ items, rows of a batch
 *                │ shard counters               │
 *   ─────────────┼──────────────────────────────┼───────────────────────────────
 *   intensive    │ coordinates, image frames,   │ an exclusive lease, a GPU slot,
 *   (no sum)     │ vision label sets, config    │ a lock token
 *
 * The top-left cell is the one the single-axis story gets wrong. An STT node's
 * transcript is a CHANGE (concatenating successive segments is exactly right) but
 * wiring it to both a translator and a subtitle sink must give each the WHOLE
 * sentence. It is not indivisible-so-route-it-somewhere; it is a fact, and facts
 * are free to copy. Round-robining a transcript between two consumers would be a
 * bug. Splitting belongs to resources, not to changes.
 *
 * ## Why `sum` is refused on an intensive port
 *
 * Positions form a *torsor* over the vector space of displacements: `a + b` is
 * meaningless, `a - b` is a displacement (which IS extensive), and `mean(a, b)` is
 * fine because its coefficients sum to 1 — an affine combination, not a linear
 * one. That is the whole reason the legality table below gates `sum`/`concat` and
 * nothing else: every other rule (mean, median, min, max, mode, set, first, last)
 * is either a selection or an affine combination, and both are legal on a state.
 *
 * rgui does NOT execute graphs — the host does. rgui's job is to let a port
 * DECLARE its algebra, to VALIDATE wiring against it, and to RENDER the
 * difference (a split wire does not look like a broadcast wire). Execution
 * combinators here are pure, dependency-free reference semantics the host may
 * use or ignore.
 *
 * ## Mapping to sflow (snomiao/sflow — WebStreams; vendored at lib/sflow)
 *
 *   fanout "copy"   → `tees()` / `.fork()`      (ReadableStream.tee — duplicates)
 *   fanout "route"  → `distributeBys(fn)`       (each chunk to exactly ONE branch)
 *                     `confluences({order:"breadth"})` for the fair/round-robin case
 *   fanout "split"  → no sflow equivalent; conservation is what rgui adds here.
 *                     For grain "atom", compose `lines()` (atom boundaries) with a
 *                     distribute step.
 *   merge extensive → `merges()` / `parallels()` (interleave — concat semantics)
 *   merge intensive → `toLatests()`              (i.e. MergeRule "last")
 */
import type { MergeRule } from "./aggregate.js";
import type { Graph, Port, SignalKind } from "./graph.js";

/**
 * FAN-IN: is addition meaningful when several sources converge?
 *
 * - "extensive": summing/concatenating parallel sources is meaningful. Counts,
 *   durations, transcript segments, audio chunks.
 * - "intensive": addition is nonsense; only selection (mode/first/last/min/max)
 *   or affine combination (mean/median) may merge. Coordinates, frames, label
 *   sets, temperatures, sample rates.
 */
export type Measure = "extensive" | "intensive";

/**
 * Whether the signal on this port may be DUPLICATED, and if not, how one value
 * is shared out. Substructural, in the type-theory sense: "copy" permits
 * contraction, the other two forbid it.
 *
 * - "copy": broadcast. The value is a FACT — duplicating it is free and every
 *   downstream sees the identical value. Idempotent.
 * - "split": conserve. The value is a divisible RESOURCE — the parts handed to
 *   the downstreams sum back to the whole. Needs a `grain` (where cuts are legal).
 * - "route": conserve, indivisibly. The value is an atomic RESOURCE or work item
 *   — it goes to exactly ONE downstream, whole. Copying would double-spend it;
 *   cutting would destroy it.
 *
 * The name is for the case that makes it visible: on an OUTPUT port feeding
 * several edges, this decides the distribution. On an INPUT port there is
 * nothing to distribute, and it instead declares what the consumer expects —
 * anything but "copy" means the consumer takes ownership of what arrives, so
 * feeding it from a broadcasting output is a double-spend (see `copied-resource`).
 */
export type Fanout = "copy" | "split" | "route";

/**
 * Where a "split" may legally cut. The POLICY is a property of the type; the
 * actual boundaries are a property of the value (a JSONL blob is line-grained,
 * but only the value knows where its newlines are), so rgui carries the policy
 * and the host locates the atoms.
 */
export type Grain =
  /** divisible anywhere: numbers, a byte budget, a duration */
  | "continuous"
  /** divisible only at atom boundaries named by `atom` (lines, frames, rows) */
  | "atom";

/** The algebra a port declares. Every field is optional on a Port; see DEFAULTS. */
export interface SignalSpec {
  measure: Measure;
  fanout: Fanout;
  /** split only */
  grain?: Grain;
  /** declarative atom-boundary tag for grain "atom": "line" | "frame" | "row" | … */
  atom?: string;
  /** fan-in rule; defaults per `defaultMerge` */
  merge?: MergeRule;
}

/**
 * Unmarked ports behave exactly as they did before this module existed: a wire
 * carries a value, nothing is summed, nothing is divided. Both defaults are the
 * SAFE choice — copying a fact never destroys anything, and refusing to sum
 * never fabricates anything.
 */
export const DEFAULT_SIGNAL: SignalSpec = {
  measure: "intensive",
  fanout: "copy",
};

/** The only rules that require additivity — the entire content of the gate. */
export const ADDITIVE_RULES: readonly MergeRule[] = ["sum", "concat"];

/** merge rules legal on a port of this measure (custom fns are always allowed) */
export function allowedMerges(measure: Measure): MergeRule[] {
  const selection: MergeRule[] = [
    "mode",
    "set",
    "first",
    "last",
    "same",
    "count",
    "min",
    "max",
    "any",
    "all",
    "range",
    "mean",
    "median",
  ];
  return measure === "extensive"
    ? [...ADDITIVE_RULES, ...selection]
    : selection;
}

/**
 * Is this fan-in rule legal on this measure? Only `sum`/`concat` can be illegal:
 * they are the two rules that presuppose a monoid. Custom reducers opt out of
 * the check — the host asserted it knows what it is doing.
 */
export function isMergeLegal(rule: MergeRule, measure: Measure): boolean {
  if (typeof rule === "function") return true;
  if (!ADDITIVE_RULES.includes(rule)) return true;
  return measure === "extensive";
}

/** does this signal conserve its value across a fan-out? (i.e. is it linear?) */
export const isConserved = (s: SignalSpec): boolean => s.fanout !== "copy";

/** resolve a port's declared algebra against the defaults */
export function resolveSignal(port: Port): SignalSpec {
  return {
    measure: port.measure ?? DEFAULT_SIGNAL.measure,
    fanout: port.fanout ?? DEFAULT_SIGNAL.fanout,
    grain: port.grain,
    atom: port.atom,
    merge: port.merge,
  };
}

/**
 * The fan-in rule a port uses when it declares none. Extensive TEXT and AUDIO
 * concatenate (joining two transcript halves is the point); every other
 * extensive carrier sums; intensive ports take the latest value, matching
 * sflow's `toLatests()`.
 */
export function defaultMerge(kind: SignalKind, measure: Measure): MergeRule {
  if (measure !== "extensive") return "last";
  return kind === "text" || kind === "audio" ? "concat" : "sum";
}

/** the effective fan-in rule for a port */
export function portMerge(port: Port): MergeRule {
  const s = resolveSignal(port);
  return s.merge ?? defaultMerge(port.kind, s.measure);
}

// --- reference fan-out semantics (pure; no streams, no dependencies) ------
//
// A host executing the graph may use these directly, or read the SignalSpec and
// wire up sflow / RxJS / its own scheduler. They exist so "conserving split" has
// exactly one definition and it is testable.

/** normalize N weights to sum 1; missing/degenerate weights fall back to even */
export function normalizeWeights(n: number, weights?: number[]): number[] {
  if (n <= 0) return [];
  const w = weights?.length === n ? weights.map((x) => (x > 0 ? x : 0)) : null;
  const total = w ? w.reduce((a, b) => a + b, 0) : 0;
  if (!w || total <= 0) return Array.from({ length: n }, () => 1 / n);
  return w.map((x) => x / total);
}

/**
 * Split a continuous quantity so the parts sum EXACTLY back to `total` — the
 * final part absorbs the floating-point residue rather than letting it leak.
 */
export function splitQuantity(total: number, weights: number[]): number[] {
  const w = normalizeWeights(weights.length, weights);
  const out: number[] = [];
  let taken = 0;
  let cum = 0;
  for (let i = 0; i < w.length; i++) {
    cum += w[i] ?? 0;
    const upto = i === w.length - 1 ? total : total * cum;
    out.push(upto - taken);
    taken = upto;
  }
  return out;
}

/**
 * Split indivisible atoms across N downstreams, conserving the COUNT exactly
 * (largest-remainder / Hare quota — the apportionment method, because handing
 * out whole atoms in proportion to weights is literally apportionment). Atom
 * order is preserved: downstream i receives a contiguous run.
 */
export function splitAtoms<T>(atoms: T[], weights: number[]): T[][] {
  const w = normalizeWeights(weights.length, weights);
  if (!w.length) return [];
  const n = atoms.length;
  const exact = w.map((x) => x * n);
  const counts = exact.map((x) => Math.floor(x));
  let short = n - counts.reduce((a, b) => a + b, 0);
  // hand the leftovers to the largest fractional remainders, ties to the left
  const order = exact
    .map((x, i): [number, number] => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < order.length && short > 0; k++, short--) {
    const i = order[k]![1];
    counts[i] = (counts[i] ?? 0) + 1;
  }
  const out: T[][] = [];
  let p = 0;
  for (const c of counts) {
    out.push(atoms.slice(p, p + c));
    p += c;
  }
  return out;
}

/**
 * Round-robin destination for the `seq`-th indivisible chunk among `n`
 * downstreams — the fair, stateless "route" policy (sflow: `distributeBys` with
 * a counter, or `confluences({ order: "breadth" })` on the merge side). Hosts
 * wanting hash- or key-partitioning substitute their own index function.
 */
export function routeIndex(seq: number, n: number): number {
  return n > 0 ? ((seq % n) + n) % n : 0;
}

/** split a text blob at "line" atom boundaries, newline kept with its line */
export function splitLines(text: string): string[] {
  return text.length ? text.split(/(?<=\n)/g) : [];
}

/**
 * How a grain-"atom" value comes apart and goes back together: `atoms` lists the
 * indivisible pieces, `join` reassembles a subset of them into a value of the
 * same type. Together they say the value is a free monoid over its atoms, which
 * is precisely what makes a conserving split well defined —
 * `join(atoms(v)) === v`, and joining the parts of a split reproduces the whole.
 *
 * An atom need not have the value's own type (an atom of `Row[]` is a `Row`),
 * so the two type parameters stay separate.
 */
export interface Atomizer<T, A> {
  atoms: (value: T) => A[];
  join: (parts: A[]) => T;
}

/** text splits at line boundaries and rejoins by concatenation */
export const lineAtomizer: Atomizer<string, string> = {
  atoms: splitLines,
  join: (parts) => parts.join(""),
};

/** an array is already a list of atoms; joining is the identity */
const arrayAtomizer = <A>(): Atomizer<A[], A> => ({
  atoms: (v) => v,
  join: (parts) => parts,
});

/**
 * Reference fan-out of one value to `n` downstreams under a port's algebra.
 * Returns `n` slots; a "route" fan-out fills exactly one and leaves the rest
 * `undefined` (nothing was sent there — which is the point).
 *
 * `seq` is the chunk's index in the output stream; only "route" reads it, and
 * it is passed in rather than counted here so this stays pure.
 */
export function forkValue<T, A = unknown>(
  value: T,
  spec: SignalSpec,
  n: number,
  opts: { weights?: number[]; seq?: number; atomizer?: Atomizer<T, A> } = {},
): (T | undefined)[] {
  if (n <= 0) return [];
  if (spec.fanout === "copy") return Array.from({ length: n }, () => value);
  if (spec.fanout === "route") {
    const out: (T | undefined)[] = Array.from({ length: n }, () => undefined);
    out[routeIndex(opts.seq ?? 0, n)] = value;
    return out;
  }
  // split — conserve the whole across the parts
  const weights = normalizeWeights(n, opts.weights);
  if (spec.grain === "atom") {
    const az =
      opts.atomizer ??
      (typeof value === "string"
        ? (lineAtomizer as unknown as Atomizer<T, A>)
        : Array.isArray(value)
          ? (arrayAtomizer() as unknown as Atomizer<T, A>)
          : null);
    if (!az)
      throw new TypeError(
        `rgui: fanout "split" with grain "atom" needs an atomizer for ${typeof value} values (text and arrays have defaults)`,
      );
    return splitAtoms(az.atoms(value), weights).map((p) => az.join(p));
  }
  if (typeof value === "number")
    return splitQuantity(value, weights) as unknown as T[];
  // a non-numeric continuous value has no defined cut — refuse rather than guess
  throw new TypeError(
    `rgui: fanout "split" with grain "continuous" needs a numeric value (got ${typeof value})`,
  );
}

// --- validation --------------------------------------------------------

export type SignalSeverity = "error" | "warn";

export interface SignalDiagnostic {
  severity: SignalSeverity;
  /** stable machine-readable code */
  code:
    | "sum-on-state"
    | "kind-mismatch"
    | "grain-without-split"
    | "atom-without-grain"
    | "unmerged-fan-in"
    | "copied-resource";
  message: string;
  node?: string;
  port?: string;
}

const portOf = (g: Graph, nodeId: string, portId: string, dir: "in" | "out") =>
  g.nodes
    .find((n) => n.id === nodeId)
    ?.[dir === "in" ? "inputs" : "outputs"].find((p) => p.id === portId);

/**
 * Check a graph's wiring against its declared signal algebra. Pure — returns
 * diagnostics rather than throwing, because a graph mid-edit is allowed to be
 * momentarily wrong and the canvas would rather draw the problem than crash.
 *
 * The load-bearing check is `sum-on-state`: a fan-in that would add up values
 * whose type has no addition.
 */
export function checkSignals(graph: Graph): SignalDiagnostic[] {
  const out: SignalDiagnostic[] = [];

  for (const n of graph.nodes)
    for (const p of [...n.inputs, ...n.outputs]) {
      const s = resolveSignal(p);
      if (s.grain && s.fanout !== "split")
        out.push({
          severity: "warn",
          code: "grain-without-split",
          message: `port "${p.id}" declares grain "${s.grain}" but fanout is "${s.fanout}" — grain only governs a split`,
          node: n.id,
          port: p.id,
        });
      if (s.atom && s.grain !== "atom")
        out.push({
          severity: "warn",
          code: "atom-without-grain",
          message: `port "${p.id}" names atom "${s.atom}" but grain is not "atom"`,
          node: n.id,
          port: p.id,
        });
      if (s.merge && !isMergeLegal(s.merge, s.measure))
        out.push({
          severity: "error",
          code: "sum-on-state",
          message: `port "${p.id}" merges with "${String(s.merge)}" but is intensive — adding states is undefined (a + b of two positions). Use mean/median/min/max/mode/first/last, or declare measure "extensive".`,
          node: n.id,
          port: p.id,
        });
    }

  // fan-in: several edges converging on one input port
  const fanIn = new Map<string, number>();
  for (const e of graph.edges) {
    const key = `${e.to.node} ${e.to.port}`;
    fanIn.set(key, (fanIn.get(key) ?? 0) + 1);
  }
  for (const [key, count] of fanIn) {
    if (count < 2) continue;
    const [nodeId = "", portId = ""] = key.split(" ");
    const p = portOf(graph, nodeId, portId, "in");
    if (!p) continue;
    const s = resolveSignal(p);
    if (!s.merge)
      out.push({
        severity: "warn",
        code: "unmerged-fan-in",
        message: `${count} edges converge on "${nodeId}.${portId}" with no merge rule — defaulting to "${String(defaultMerge(p.kind, s.measure))}"`,
        node: nodeId,
        port: portId,
      });
  }

  // fan-out: one output port feeding several edges
  const fanOut = new Map<string, number>();
  for (const e of graph.edges) {
    const key = `${e.from.node} ${e.from.port}`;
    fanOut.set(key, (fanOut.get(key) ?? 0) + 1);
  }
  for (const [key, count] of fanOut) {
    if (count < 2) continue;
    const [nodeId = "", portId = ""] = key.split(" ");
    const p = portOf(graph, nodeId, portId, "out");
    if (!p) continue;
    const s = resolveSignal(p);
    if (s.fanout === "split" && !s.grain)
      out.push({
        severity: "warn",
        code: "grain-without-split",
        message: `"${nodeId}.${portId}" splits across ${count} edges but declares no grain — assuming "continuous"`,
        node: nodeId,
        port: portId,
      });
  }

  // wires must carry the same kind at both ends
  for (const e of graph.edges) {
    const a = portOf(graph, e.from.node, e.from.port, "out");
    const b = portOf(graph, e.to.node, e.to.port, "in");
    if (!a || !b) continue;
    if (a.kind !== b.kind)
      out.push({
        severity: "warn",
        code: "kind-mismatch",
        message: `wire ${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port} joins "${a.kind}" to "${b.kind}"`,
        node: e.to.node,
        port: e.to.port,
      });
    // a conserved resource broadcast into a consumer that also conserves it is
    // a double-spend: the same 100 coins arriving at two sinks
    if (resolveSignal(a).fanout === "copy" && isConserved(resolveSignal(b)))
      out.push({
        severity: "warn",
        code: "copied-resource",
        message: `"${e.to.node}.${e.to.port}" treats its input as a conserved resource, but "${e.from.node}.${e.from.port}" broadcasts copies of it`,
        node: e.to.node,
        port: e.to.port,
      });
  }

  return out;
}

// --- presets: the primitive signal types rgui hands its hosts -------------
//
// `kind` alone cannot decide the algebra — "text" is extensive when it is an STT
// transcript and intensive when it is a vision model's label set. That ambiguity
// is exactly why measure/fanout live on the PORT and not in a table keyed by
// kind. These presets name the combinations that keep recurring.

type Preset = SignalSpec & { kind: SignalKind };

export const SIGNALS = {
  /** STT segments: concat-able across time, and a FACT — broadcast to all */
  transcript: { kind: "text", measure: "extensive", fanout: "copy" },
  /** vision labels ("person, chair"): a snapshot; concatenating frames is nonsense */
  labels: { kind: "text", measure: "intensive", fanout: "copy" },
  /** line-delimited records to be shared out across workers, never cut mid-line */
  jsonl: {
    kind: "text",
    measure: "extensive",
    fanout: "split",
    grain: "atom",
    atom: "line",
  },
  /** a single image: a state, copied whole */
  frame: { kind: "image", measure: "intensive", fanout: "copy" },
  /** PCM chunks: concat-able in time, and freely copied to recorder + STT */
  pcm: { kind: "audio", measure: "extensive", fanout: "copy" },
  /** a position/setting: no addition, freely copied */
  coord: { kind: "ctl", measure: "intensive", fanout: "copy" },
  /** a divisible allowance (tokens/sec, bytes): splits continuously, conserved */
  budget: {
    kind: "ctl",
    measure: "extensive",
    fanout: "split",
    grain: "continuous",
  },
  /** work items: additive in count, indivisible individually — round-robin them */
  work: { kind: "ctl", measure: "extensive", fanout: "route" },
  /** an exclusive lease/lock/slot: neither addable nor copyable */
  lease: { kind: "ctl", measure: "intensive", fanout: "route" },
} as const satisfies Record<string, Preset>;

/** build a Port from a preset: `port("audio", "mic", SIGNALS.pcm)` */
export function port(id: string, label: string, preset: Preset): Port {
  return { id, label, ...preset };
}
