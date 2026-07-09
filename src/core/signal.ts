/**
 * rgui core — the SIGNAL ALGEBRA: what a wire carries, and what happens to it
 * when wires fork (one output → many edges) or converge (many edges → one input).
 *
 * `MergeRule` (aggregate.ts) already answers "how do FIELD VALUES combine when
 * nodes renormalize into a block". This module answers the same question one
 * level down, for the DATA on the ports — and adds the question renormalization
 * never had to ask: what happens on the way OUT.
 *
 * ## Three questions, three owners
 *
 *   MEASURE    — is `+` meaningful across parallel sources?  owned by: the port
 *   OWNERSHIP  — MAY this value be duplicated / aliased?     owned by: the producing port
 *   FANOUT     — is it duplicated HERE, or divided?          owned by: the fan-out group
 *
 * `ownership` and `fanout` are deliberately separate. One says what the data IS
 * (a capability, intrinsic, not overridable downstream); the other says what
 * this particular topology DOES with it (a policy, chosen per fan-out site).
 * Conflating them cannot express "a 4K frame may be copied, but broadcasting it
 * to three consumers on three machines means serializing it three times".
 *
 * Note what is NOT here: transport. Whether a value can cross a machine or
 * process boundary depends on where the nodes LAND, and only the host knows that.
 * rgui says whether a value may be duplicated (`isDuplicable`); the host composes
 * that with its own placement. Every verdict rgui reaches is placement-independent.
 *
 * ## Why measure and ownership are two axes, not one
 *
 * The tempting model is a single axis — "change vs state", where a change is
 * additive and splittable and a state is neither. It is the right intuition and
 * the wrong factorization. It breaks in both directions:
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
 *                │ copy / clone / share         │ move
 *   ─────────────┼──────────────────────────────┼───────────────────────────────
 *   extensive    │ STT transcript segments,     │ token budget, money, work
 *   (sum/concat) │ audio chunks, log lines,     │ items, rows of a batch
 *                │ shard counters               │
 *   ─────────────┼──────────────────────────────┼───────────────────────────────
 *   intensive    │ coordinates, image frames,   │ an exclusive lease, a GPU slot,
 *   (no sum)     │ vision labels, MediaStream   │ a lock token
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
 *   fanout "broadcast" → `tees()` / `.fork()`  (ReadableStream.tee — duplicates)
 *   fanout "route"     → `distributeBys(fn)`   (each chunk to exactly ONE branch)
 *                        `confluences({order:"breadth"})` for the fair/round-robin case
 *   fanout "split"     → no sflow equivalent; conservation is what rgui adds here.
 *                        For grain "atom", compose `lines()` (atom boundaries) with a
 *                        distribute step.
 *   merge extensive    → `merges()` / `parallels()` (interleave — concat semantics)
 *   merge intensive    → `toLatests()`              (i.e. MergeRule "last")
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
 * OWNERSHIP — may this value be duplicated, and may several consumers hold it at
 * once? Owned by the PRODUCING port and not overridable downstream: only the node
 * emitting a value knows whether it hands out a coordinate or a MediaStream
 * handle. Substructural, in the type-theory sense — "copy" permits contraction,
 * "move" forbids it, and "share" sits between them.
 *
 * These are Rust's four, and for the same reasons:
 *
 * - "copy":  `Copy`. Duplication is free. Coordinates, labels, config, a transcript.
 * - "clone": `Clone`. Duplication is legal but COSTS. A 4K frame, a PCM chunk —
 *   broadcasting one to three consumers on three machines serializes and ships it
 *   three times. Legal, and worth saying out loud.
 * - "share": `Arc<T>` / `&T`. The value CANNOT be duplicated, but several
 *   consumers may hold the same one. A MediaStream, a GPU buffer, an
 *   OffscreenCanvas. Handing it to two downstream nodes in one process is a
 *   shared borrow, not a copy — so broadcasting it is LEGAL.
 * - "move":  single ownership. The value may be held by exactly one consumer.
 *   Either duplicating it double-spends it (money, a token budget, a work item)
 *   or aliasing it breaks exclusivity (a lease, a lock). A "move" port may never
 *   broadcast.
 *
 * The "share" rung is what lets rgui judge a fan-out WITHOUT knowing placement.
 * A shared reference is unsafe to duplicate but safe to alias, so its broadcast
 * is legal everywhere; a "move" is illegal everywhere. Neither verdict depends on
 * which machine a node lands on. Whether a non-duplicable value can CROSS a
 * device boundary is a transport question, and transport belongs to the host —
 * see `isDuplicable`, which is the predicate a host needs for exactly that check.
 */
export type Ownership = "copy" | "clone" | "share" | "move";

/**
 * POLICY — what one output port does when it feeds several edges. Owned by the
 * FAN-OUT GROUP (the set of edges leaving that port), not by any single edge:
 * you cannot have one edge of a group broadcast while another splits, because
 * conservation is a property of the whole division. The port carries the group's
 * default; `Graph.fanout` overrides it per group; `Edge.weight` tunes the shares
 * within a split.
 *
 * - "broadcast": every downstream receives the whole value. Illegal on "move".
 * - "split": the value is divided; the parts sum back to the whole. Needs a
 *   `grain` (where cuts are legal). Legal on any share — dividing a copyable
 *   value is a load-balancing choice, not a safety one.
 * - "route": the whole value goes to exactly ONE downstream. For indivisible
 *   resources and work items.
 */
export type Fanout = "broadcast" | "split" | "route";

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
  ownership: Ownership;
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
 * carries a value, nothing is summed, nothing is divided, and a second edge off
 * the same port simply broadcasts (as every node editor does). All three
 * defaults are the SAFE choice — copying a fact never destroys anything, and
 * refusing to sum never fabricates anything.
 */
export const DEFAULT_SIGNAL: SignalSpec = {
  measure: "intensive",
  ownership: "copy",
  fanout: "broadcast",
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

/**
 * Can independent copies of this value be made? The predicate a HOST needs for
 * its transport check: a value that is not duplicable cannot be serialized across
 * a device or process boundary — it can only be used where it lives. rgui does
 * not know placement, so it never performs that check; it exports the predicate
 * and lets the host apply it to its own edges.
 */
export const isDuplicable = (o: Ownership): boolean =>
  o === "copy" || o === "clone";

/**
 * May several consumers hold this value at once? True for everything but "move".
 * A shared reference is unsafe to duplicate yet safe to ALIAS, which is exactly
 * why its broadcast is legal without knowing where anything runs.
 */
export const isAliasable = (o: Ownership): boolean => o !== "move";

/**
 * Is this fan-out policy permitted by the value's ownership? The single
 * constraint: a "move" value may not be broadcast, because broadcasting means
 * several consumers hold it at once and "move" is single-ownership. Everything
 * else is allowed — splitting a copyable value is a load-balancing decision, not
 * a safety one, and broadcasting a handle is a borrow, not a copy.
 *
 * Both verdicts are placement-independent. That is the whole point of the
 * "share" rung: rgui can decide them without knowing which machine a node
 * lands on.
 */
export function isFanoutLegal(ownership: Ownership, fanout: Fanout): boolean {
  return isAliasable(ownership) || fanout !== "broadcast";
}

/** single ownership — duplicating OR aliasing it violates a conservation law */
export const isConserved = (s: SignalSpec): boolean => s.ownership === "move";

/** is duplicating it legal but expensive? (a warning, never an error) */
export const isCostlyToCopy = (s: SignalSpec): boolean =>
  s.ownership === "clone";

/** resolve a port's declared algebra against the defaults */
export function resolveSignal(port: Port): SignalSpec {
  return {
    measure: port.measure ?? DEFAULT_SIGNAL.measure,
    ownership: port.ownership ?? DEFAULT_SIGNAL.ownership,
    fanout: port.fanout ?? DEFAULT_SIGNAL.fanout,
    grain: port.grain,
    atom: port.atom,
    merge: port.merge,
  };
}

/** the key a fan-out group is addressed by: "nodeId.portId" */
export const fanoutKey = (nodeId: string, portId: string): string =>
  `${nodeId}.${portId}`;

/**
 * The policy governing one fan-out group. The port declares the default; the
 * GRAPH may override it per group, because the same audio-segment port feeds a
 * recorder (broadcast) in one graph and a worker pool (route) in another. That
 * is a topology decision, and topology belongs to the graph.
 */
export function groupFanout(
  graph: Graph,
  nodeId: string,
  portId: string,
): Fanout {
  const override = graph.fanout?.[fanoutKey(nodeId, portId)];
  if (override) return override;
  const p = graph.nodes
    .find((n) => n.id === nodeId)
    ?.outputs.find((o) => o.id === portId);
  return p ? resolveSignal(p).fanout : DEFAULT_SIGNAL.fanout;
}

/** the edges leaving one output port, in graph order */
export function fanoutGroup(graph: Graph, nodeId: string, portId: string) {
  return graph.edges.filter(
    (e) => e.from.node === nodeId && e.from.port === portId,
  );
}

/**
 * The fan-out weights of a group, normalized to sum 1. Per-EDGE, because only
 * the shares may differ within a group — the policy may not. An edge with no
 * `weight` counts as 1.
 */
export function groupWeights(
  graph: Graph,
  nodeId: string,
  portId: string,
): number[] {
  const edges = fanoutGroup(graph, nodeId, portId);
  return normalizeWeights(
    edges.length,
    edges.map((e) => e.weight ?? 1),
  );
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
  if (!isFanoutLegal(spec.ownership, spec.fanout))
    throw new TypeError(
      `rgui: a "move" signal cannot broadcast — it has a single owner. Declare fanout "split" or "route", or ownership "share" if consumers may alias it.`,
    );
  if (spec.fanout === "broadcast") return Array.from({ length: n }, () => value);
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
    | "broadcast-move"
    | "cloned-fanout"
    | "kind-mismatch"
    | "grain-without-split"
    | "atom-without-grain"
    | "weight-without-split"
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
 * The two load-bearing checks are `sum-on-state` (a fan-in that would add up
 * values whose type has no addition) and `broadcast-move` (a fan-out that would
 * duplicate a value whose duplication is forbidden).
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
    const key = fanoutKey(e.to.node, e.to.port);
    fanIn.set(key, (fanIn.get(key) ?? 0) + 1);
  }
  for (const [key, count] of fanIn) {
    if (count < 2) continue;
    const at = key.lastIndexOf(".");
    const nodeId = key.slice(0, at);
    const portId = key.slice(at + 1);
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

  // fan-out: one output port feeding several edges. The policy is the GROUP's,
  // so it is read through groupFanout (port default, graph override).
  const fanOut = new Map<string, number>();
  for (const e of graph.edges) {
    const key = fanoutKey(e.from.node, e.from.port);
    fanOut.set(key, (fanOut.get(key) ?? 0) + 1);
  }
  for (const [key, count] of fanOut) {
    const at = key.lastIndexOf(".");
    const nodeId = key.slice(0, at);
    const portId = key.slice(at + 1);
    const p = portOf(graph, nodeId, portId, "out");
    if (!p) continue;
    const s = resolveSignal(p);
    const policy = groupFanout(graph, nodeId, portId);

    if (fanoutGroup(graph, nodeId, portId).some((e) => e.weight !== undefined) &&
      policy !== "split")
      out.push({
        severity: "warn",
        code: "weight-without-split",
        message: `"${nodeId}.${portId}" carries per-edge weights but its fan-out is "${policy}" — weights only apportion a split`,
        node: nodeId,
        port: portId,
      });

    if (count < 2) continue;

    // the load-bearing fan-out check: duplicating what must not be duplicated
    if (!isFanoutLegal(s.ownership, policy))
      out.push({
        severity: "error",
        code: "broadcast-move",
        message: `"${nodeId}.${portId}" broadcasts to ${count} edges but its signal is "move" — it has a single owner. Declare fanout "split" (with a grain) or "route", or ownership "share" if consumers may safely alias it.`,
        node: nodeId,
        port: portId,
      });
    // legal, but say the cost out loud
    else if (isCostlyToCopy(s) && policy === "broadcast")
      out.push({
        severity: "warn",
        code: "cloned-fanout",
        message: `"${nodeId}.${portId}" broadcasts a "clone" signal (${p.kind}) to ${count} consumers — each gets its own copy`,
        node: nodeId,
        port: portId,
      });

    if (policy === "split" && !s.grain)
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
    // a conserved resource broadcast into a consumer that takes ownership is a
    // double-spend: the same 100 coins arriving whole at two sinks
    if (
      groupFanout(graph, e.from.node, e.from.port) === "broadcast" &&
      isConserved(resolveSignal(b)) &&
      fanoutGroup(graph, e.from.node, e.from.port).length > 1
    )
      out.push({
        severity: "warn",
        code: "copied-resource",
        message: `"${e.to.node}.${e.to.port}" takes ownership of its input, but "${e.from.node}.${e.from.port}" broadcasts copies of it`,
        node: e.to.node,
        port: e.to.port,
      });
  }

  return out;
}

/**
 * A connection guard for `createRgui({ isValidConnection })`: refuses the edge
 * that would make a "move" port broadcast. Everything else is allowed — a
 * "clone" fan-out is legal (checkSignals warns about its cost), and a "copy"
 * fan-out is the everyday broadcast every node editor performs.
 *
 * This is where "single-to-single by default" actually bites, and it bites only
 * where duplication is unsafe rather than merely expensive.
 */
export function signalConnectionGuard(
  graph: () => Graph,
): (from: { node: string; port: string }, to: { node: string; port: string }) => boolean {
  return (from) => {
    const g = graph();
    const p = portOf(g, from.node, from.port, "out");
    if (!p) return true;
    const s = resolveSignal(p);
    const policy = groupFanout(g, from.node, from.port);
    const existing = fanoutGroup(g, from.node, from.port).length;
    // a second edge on a broadcasting "move" port is the forbidden aliasing
    return !(existing >= 1 && !isFanoutLegal(s.ownership, policy));
  };
}

// --- presets: the primitive signal types rgui hands its hosts -------------
//
// `kind` alone cannot decide the algebra — "text" is extensive when it is an STT
// transcript and intensive when it is a vision model's label set. That ambiguity
// is exactly why measure/share/fanout live on the PORT and not in a table keyed
// by kind. These presets name the combinations that keep recurring.

type Preset = Omit<SignalSpec, "merge"> & { kind: SignalKind; merge?: MergeRule };

export const SIGNALS = {
  /** STT segments: concat-able across time, and a cheap FACT — broadcast to all */
  transcript: {
    kind: "text",
    measure: "extensive",
    ownership: "copy",
    fanout: "broadcast",
  },
  /** vision labels ("person, chair"): a snapshot; concatenating frames is nonsense */
  labels: {
    kind: "text",
    measure: "intensive",
    ownership: "copy",
    fanout: "broadcast",
  },
  /** line-delimited records shared out across workers, never cut mid-line */
  jsonl: {
    kind: "text",
    measure: "extensive",
    ownership: "copy",
    fanout: "split",
    grain: "atom",
    atom: "line",
  },
  /** a single image: a state, and a BIG one — copying it costs */
  frame: {
    kind: "image",
    measure: "intensive",
    ownership: "clone",
    fanout: "broadcast",
  },
  /** PCM chunks: concat-able in time, copied to recorder + STT, but not free */
  pcm: {
    kind: "audio",
    measure: "extensive",
    ownership: "clone",
    fanout: "broadcast",
  },
  /** a position/setting: no addition, freely copied */
  coord: {
    kind: "ctl",
    measure: "intensive",
    ownership: "copy",
    fanout: "broadcast",
  },
  /**
   * a live handle — MediaStream, GPU buffer, OffscreenCanvas, file descriptor.
   * It cannot be duplicated, but two downstream nodes in the same process may
   * hold it at once (a shared borrow), so broadcasting it is legal. It cannot
   * cross a device boundary — `isDuplicable` is false — but that verdict belongs
   * to the host, which is the only side that knows where the nodes run.
   */
  handle: {
    kind: "ctl",
    measure: "intensive",
    ownership: "share",
    fanout: "broadcast",
  },
  /** a divisible allowance (tokens/sec, bytes): conserved, splits continuously */
  budget: {
    kind: "ctl",
    measure: "extensive",
    ownership: "move",
    fanout: "split",
    grain: "continuous",
  },
  /** work items: additive in count, indivisible individually — round-robin them */
  work: { kind: "ctl", measure: "extensive", ownership: "move", fanout: "route" },
  /** an exclusive lease/lock/slot: neither addable nor copyable */
  lease: { kind: "ctl", measure: "intensive", ownership: "move", fanout: "route" },
} as const satisfies Record<string, Preset>;

/** build a Port from a preset: `port("audio", "mic", SIGNALS.pcm)` */
export function port(id: string, label: string, preset: Preset): Port {
  return { id, label, ...preset };
}
