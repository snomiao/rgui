/**
 * rgui core — GraphCrdt: a dependency-free, transport-agnostic CRDT for graph
 * syncing. Pure data + a deterministic merge; how states travel is the host
 * app's business (per the scope guard: rgui does no I/O).
 *
 * Design (v1, deliberately minimal):
 * - Node/edge PRESENCE is an observed-remove set without tombstones (ORSWOT):
 *   each element keeps its live add-dots; the state-wide `clock` (a version
 *   vector) is the causal context. On merge, an element's dot survives iff
 *   both sides hold it, or one side holds it and the other has NOT seen it
 *   (dot not covered by the other's clock). Concurrent add wins over remove.
 * - FIELDS are deterministic Lamport registers: {value, dot} merged by the
 *   total order (seq, then actor). This converges deterministically but is
 *   NOT wall-clock recency. Opt-in typed joins replace LWW per field key:
 *   "max"/"min" over numbers, "any"/"all" over booleans — the only rules of
 *   the display-oriented MergeRule algebra that are true semilattice joins.
 * - REMOVE kills presence only. Field registers survive, so a re-added
 *   element resurfaces with its last-known fields (minimal, predictable).
 * - EDGES are identified by their endpoints ("a:out->b:in"); parallel edges
 *   between the same port pair are not representable (matching rgui's Graph).
 *   An edge is materialized only while both endpoint nodes are live.
 * - Replicas must share the same `joins` schema: merge() throws on mismatch
 *   instead of silently diverging projections.
 *
 * No Date.now, no randomness: the host supplies a stable unique `actor` id,
 * sequence numbers are per-state Lamport counters advanced by ops and merges.
 */

/** one write event: a per-actor Lamport sequence number */
export interface Dot {
  actor: string;
  seq: number;
}

/** version vector — highest seq observed per actor (the causal context) */
export type Clock = Record<string, number>;

/** typed semilattice joins usable instead of LWW for a field key */
export type JoinRule = "max" | "min" | "any" | "all";

/** JSON-safe field value (registers hold plain data, never functions) */
export type CrdtValue =
  | string
  | number
  | boolean
  | null
  | CrdtValue[]
  | { [key: string]: CrdtValue };

export interface CrdtRegister {
  value: CrdtValue;
  dot: Dot;
}

interface CrdtElement {
  /** live add-dots — empty means removed (element record may linger; it is
   * presence-dead and skipped at materialization) */
  dots: Dot[];
  fields: Record<string, CrdtRegister>;
}

export interface CrdtEdgeEnd {
  node: string;
  port: string;
}

export interface GraphCrdtState {
  /** schema tag: per-field join rules; must match across replicas */
  joins: Record<string, JoinRule>;
  clock: Clock;
  nodes: Record<string, CrdtElement>;
  edges: Record<string, CrdtElement>;
}

/** materialized plain-data view (host maps this onto a render Graph) */
export interface CrdtGraph {
  nodes: { id: string; fields: Record<string, CrdtValue> }[];
  edges: { id: string; from: CrdtEdgeEnd; to: CrdtEdgeEnd }[];
}

export function newGraphCrdt(joins: Record<string, JoinRule> = {}): GraphCrdtState {
  return { joins: { ...joins }, clock: {}, nodes: {}, edges: {} };
}

/**
 * Deterministic endpoint-derived edge id (no parallel edges by design).
 * JSON-array encoded so it stays injective for ARBITRARY node/port strings —
 * a plain `a:b->c:d` template would collide when ids contain the delimiters.
 */
export function crdtEdgeId(from: CrdtEdgeEnd, to: CrdtEdgeEnd): string {
  return JSON.stringify([from.node, from.port, to.node, to.port]);
}

/** deep-validate a field value: plain JSON only, and join-typed keys typed */
function assertValue(key: string, value: unknown, joins: Record<string, JoinRule>): void {
  const rule = joins[key];
  if (rule === "max" || rule === "min") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`GraphCrdt: field "${key}" (join ${rule}) requires a finite number`);
    return;
  }
  if (rule === "any" || rule === "all") {
    if (typeof value !== "boolean")
      throw new Error(`GraphCrdt: field "${key}" (join ${rule}) requires a boolean`);
    return;
  }
  assertJsonSafe(key, value);
}

function assertJsonSafe(key: string, value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`GraphCrdt: field "${key}" holds a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertJsonSafe(key, v);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) assertJsonSafe(key, v);
    return;
  }
  // undefined / function / symbol / bigint — silently mangled by JSON, reject
  throw new Error(`GraphCrdt: field "${key}" holds a non-JSON value (${typeof value})`);
}

function nextDot(state: GraphCrdtState, actor: string): Dot {
  const seq = maxClockSeq(state.clock) + 1; // Lamport: exceed everything seen
  state.clock[actor] = seq;
  return { actor, seq };
}

function maxClockSeq(clock: Clock): number {
  let m = 0;
  for (const s of Object.values(clock)) if (s > m) m = s;
  return m;
}

function covered(clock: Clock, dot: Dot): boolean {
  return (clock[dot.actor] ?? 0) >= dot.seq;
}

function lwwWins(a: Dot, b: Dot): boolean {
  return a.seq !== b.seq ? a.seq > b.seq : a.actor > b.actor;
}

function liveElement(el: CrdtElement | undefined): boolean {
  return !!el && el.dots.length > 0;
}

function setFieldsOn(
  state: GraphCrdtState,
  el: CrdtElement,
  actor: string,
  fields: Record<string, CrdtValue>,
): void {
  // validate everything BEFORE writing anything (no partial writes on throw)
  for (const [key, value] of Object.entries(fields)) assertValue(key, value, state.joins);
  for (const [key, value] of Object.entries(fields)) {
    el.fields[key] = { value, dot: nextDot(state, actor) };
  }
}

function addElement(
  map: Record<string, CrdtElement>,
  state: GraphCrdtState,
  actor: string,
  id: string,
  fields?: Record<string, CrdtValue>,
): void {
  const el = (map[id] ??= { dots: [], fields: {} });
  el.dots.push(nextDot(state, actor));
  if (fields) setFieldsOn(state, el, actor, fields);
}

function removeElement(map: Record<string, CrdtElement>, id: string): void {
  const el = map[id];
  if (el) el.dots = []; // drop OBSERVED dots; unseen concurrent adds survive merge
}

/** add a node (or revive a removed one), optionally writing fields */
export function crdtAddNode(
  state: GraphCrdtState,
  actor: string,
  id: string,
  fields?: Record<string, CrdtValue>,
): void {
  addElement(state.nodes, state, actor, id, fields);
}

/** write fields on a live node (no-op on unknown/removed nodes) */
export function crdtSetFields(
  state: GraphCrdtState,
  actor: string,
  id: string,
  fields: Record<string, CrdtValue>,
): void {
  const el = state.nodes[id];
  if (!liveElement(el)) return;
  setFieldsOn(state, el!, actor, fields);
}

export function crdtRemoveNode(state: GraphCrdtState, id: string): void {
  removeElement(state.nodes, id);
}

export function crdtAddEdge(
  state: GraphCrdtState,
  actor: string,
  from: CrdtEdgeEnd,
  to: CrdtEdgeEnd,
  fields?: Record<string, CrdtValue>,
): string {
  // endpoints live in the (injective) id itself — no mutable endpoint state
  const id = crdtEdgeId(from, to);
  addElement(state.edges, state, actor, id, fields);
  return id;
}

export function crdtRemoveEdge(state: GraphCrdtState, from: CrdtEdgeEnd, to: CrdtEdgeEnd): void {
  removeElement(state.edges, crdtEdgeId(from, to));
}

/** join two registers under the shared schema — deterministic + commutative.
 * Join-typed keys are validated at write time; a mismatched runtime type here
 * means a corrupt/hand-crafted imported state, and falling back to LWW would
 * break merge associativity (grouping-dependent winners) — so throw instead. */
function mergeRegister(key: string, a: CrdtRegister, b: CrdtRegister, joins: Record<string, JoinRule>): CrdtRegister {
  const rule = joins[key];
  if (rule) {
    const joined = joinValues(rule, a.value, b.value);
    if (joined === undefined)
      throw new Error(`GraphCrdt: field "${key}" (join ${rule}) holds a mistyped value — corrupt state`);
    // keep the greater dot so causality keeps advancing under the join
    return { value: joined, dot: lwwWins(a.dot, b.dot) ? a.dot : b.dot };
  }
  return lwwWins(a.dot, b.dot) ? a : b;
}

function joinValues(rule: JoinRule, a: CrdtValue, b: CrdtValue): CrdtValue | undefined {
  switch (rule) {
    case "max":
      return typeof a === "number" && typeof b === "number" ? Math.max(a, b) : undefined;
    case "min":
      return typeof a === "number" && typeof b === "number" ? Math.min(a, b) : undefined;
    case "any":
      return typeof a === "boolean" && typeof b === "boolean" ? a || b : undefined;
    case "all":
      return typeof a === "boolean" && typeof b === "boolean" ? a && b : undefined;
  }
}

function mergeElement(
  a: CrdtElement | undefined,
  b: CrdtElement | undefined,
  aClock: Clock,
  bClock: Clock,
  joins: Record<string, JoinRule>,
): CrdtElement {
  // ORSWOT dot survival: kept by both, or held by one and unseen by the other
  const aDots = a?.dots ?? [];
  const bDots = b?.dots ?? [];
  const bHas = new Set(bDots.map(dotKey));
  const aHas = new Set(aDots.map(dotKey));
  const dots = [
    ...aDots.filter((d) => bHas.has(dotKey(d)) || !covered(bClock, d)),
    ...bDots.filter((d) => !aHas.has(dotKey(d)) && !covered(aClock, d)),
  ];
  const fields: Record<string, CrdtRegister> = {};
  const keys = new Set([...Object.keys(a?.fields ?? {}), ...Object.keys(b?.fields ?? {})]);
  for (const key of keys) {
    const ra = a?.fields[key];
    const rb = b?.fields[key];
    fields[key] = ra && rb ? mergeRegister(key, ra, rb, joins) : (ra ?? rb)!;
  }
  return { dots, fields };
}

function dotKey(d: Dot): string {
  return `${d.actor} ${d.seq}`;
}

/**
 * Deterministic state merge — commutative, associative, idempotent. Inputs
 * are not mutated. Throws if the two states declare different join schemas
 * (silently merging mismatched schemas would diverge projections).
 */
export function mergeGraphCrdt(a: GraphCrdtState, b: GraphCrdtState): GraphCrdtState {
  const ja = JSON.stringify(sortedJoins(a.joins));
  const jb = JSON.stringify(sortedJoins(b.joins));
  if (ja !== jb) throw new Error(`GraphCrdt schema mismatch: ${ja} vs ${jb}`);

  const clock: Clock = { ...a.clock };
  for (const [actor, seq] of Object.entries(b.clock)) {
    clock[actor] = Math.max(clock[actor] ?? 0, seq);
  }
  const out: GraphCrdtState = { joins: { ...a.joins }, clock, nodes: {}, edges: {} };
  for (const bucket of ["nodes", "edges"] as const) {
    const ids = new Set([...Object.keys(a[bucket]), ...Object.keys(b[bucket])]);
    for (const id of ids) {
      const merged = mergeElement(a[bucket][id], b[bucket][id], a.clock, b.clock, out.joins);
      if (merged.dots.length || Object.keys(merged.fields).length) out[bucket][id] = merged;
    }
  }
  return out;
}

function sortedJoins(joins: Record<string, JoinRule>): [string, JoinRule][] {
  return Object.entries(joins).sort(([x], [y]) => (x < y ? -1 : 1));
}

/**
 * Materialize the plain-data graph view: live nodes with their current field
 * values, and live edges whose BOTH endpoint nodes are live. Output ordering
 * and field-key ordering are sorted, so equal states materialize into
 * byte-identical views regardless of merge order.
 */
export function crdtToGraph(state: GraphCrdtState): CrdtGraph {
  const nodes = Object.entries(state.nodes)
    .filter(([, el]) => liveElement(el))
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([id, el]) => ({ id, fields: fieldValues(el) }));
  const liveNodeIds = new Set(nodes.map((n) => n.id));
  const edges = Object.entries(state.edges)
    .filter(([, el]) => liveElement(el))
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .flatMap(([id]) => {
      const ends = parseEdgeId(id);
      if (!ends) return [];
      const [from, to] = ends;
      if (!liveNodeIds.has(from.node) || !liveNodeIds.has(to.node)) return [];
      return [{ id, from, to }];
    });
  return { nodes, edges };
}

function fieldValues(el: CrdtElement): Record<string, CrdtValue> {
  const out: Record<string, CrdtValue> = {};
  for (const k of Object.keys(el.fields).sort()) out[k] = el.fields[k]!.value;
  return out;
}

function parseEdgeId(id: string): [CrdtEdgeEnd, CrdtEdgeEnd] | null {
  try {
    const arr: unknown = JSON.parse(id);
    if (!Array.isArray(arr) || arr.length !== 4 || arr.some((s) => typeof s !== "string")) return null;
    const [fn, fp, tn, tp] = arr as string[];
    return [{ node: fn!, port: fp! }, { node: tn!, port: tp! }];
  } catch {
    return null;
  }
}
