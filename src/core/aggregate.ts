/**
 * rgui core — data-merge rules for renormalized nodes.
 *
 * When nodes merge into a higher-order block, their FIELD VALUES merge too,
 * using the classic reducers:
 *   - "max" / "min"  numbers (non-numeric values are ignored)
 *   - "mode"         众数 — the most frequent value; numbers and texts
 *   - "set"          集合 — distinct values, comma-joined
 *   - "count"        how many members carry the field
 */
import type { GraphNode } from "./graph.js";
import type { SummarizeFn, SummaryContent } from "./summary.js";

export type MergeRule =
  | "max"
  | "min"
  | "sum" // Σ — quantities merge additively
  | "mean" // average of numeric values
  | "range" // "min–max" spread display
  | "mode" // 众数 — most frequent (numbers and texts)
  | "set" // 集合 — distinct values, comma-joined
  | "same" // all equal → the value; else "mixed (N)" (Figma-style)
  | "any" // alias of "max" — boolean OR IS max over {0,1}
  | "all" // alias of "min" — boolean AND IS min over {0,1}
  | "first"
  | "last"
  | "count"
  | ((values: string[]) => string); // custom reducer escape hatch

const TRUTHY = new Set(["on", "true", "yes", "1", "enabled"]);
const FALSY = new Set(["off", "false", "no", "0", "disabled"]);
const isBoolish = (v: string) =>
  TRUTHY.has(v.toLowerCase()) || FALSY.has(v.toLowerCase());

/** merge a list of field values under a rule (display string out) */
export function aggregate(values: string[], rule: MergeRule): string {
  if (!values.length) return "";
  if (typeof rule === "function") return rule(values);
  const nums = () =>
    values.map((v) => parseFloat(v)).filter((n) => Number.isFinite(n));
  switch (rule) {
    case "any": // boolean OR ≡ max over {0,1}
    case "all": // boolean AND ≡ min over {0,1}
    case "max":
    case "min": {
      const wantMax = rule === "max" || rule === "any";
      // booleans are a totally ordered set: max = OR, min = AND — keep the
      // input's own vocabulary ("on"/"true"/"yes"…) in the result
      if (values.every(isBoolish)) {
        const winner = wantMax
          ? (values.find((v) => TRUTHY.has(v.toLowerCase())) ?? values[0]!)
          : (values.find((v) => FALSY.has(v.toLowerCase())) ?? values[0]!);
        return winner;
      }
      const ns = nums();
      if (!ns.length) return "";
      return String(wantMax ? Math.max(...ns) : Math.min(...ns));
    }
    case "sum": {
      const ns = nums();
      return ns.length ? String(ns.reduce((a, b) => a + b, 0)) : "";
    }
    case "mean": {
      const ns = nums();
      if (!ns.length) return "";
      const m = ns.reduce((a, b) => a + b, 0) / ns.length;
      return String(Math.round(m * 100) / 100);
    }
    case "range": {
      const ns = nums();
      if (!ns.length) return "";
      const lo = Math.min(...ns);
      const hi = Math.max(...ns);
      return lo === hi ? String(lo) : `${lo}–${hi}`;
    }
    case "same": {
      const distinct = new Set(values);
      return distinct.size === 1
        ? values[0]!
        : `mixed (${distinct.size})`;
    }
    case "first":
      return values[0]!;
    case "last":
      return values[values.length - 1]!;
    case "mode": {
      // 众数: most frequent value; ties resolve to the first seen
      const counts = new Map<string, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      let best = values[0]!;
      let n = 0;
      for (const [v, c] of counts)
        if (c > n) {
          best = v;
          n = c;
        }
      return n > 1 ? `${best} ×${n}` : best;
    }
    case "set": {
      // 集合: distinct values in first-seen order
      return [...new Set(values)].join(", ");
    }
    case "count":
      return String(values.length);
  }
}

/**
 * Build a SummarizeFn that merges member FIELDS into kv rows:
 * per-key rules (e.g. { "min score": "max", device: "set" }) with a
 * fallback rule (default "mode") for unlisted keys. Used as rgui's
 * default pseudo summary when the host provides none.
 */
export function fieldSummarize(
  rules: Record<string, MergeRule> = {},
  fallback: MergeRule = "mode",
): SummarizeFn {
  return (nodes: GraphNode[], info): SummaryContent | null => {
    if (info.level === "small") {
      const n = nodes[0];
      return n && n.fields.length ? { kind: "kv", rows: n.fields } : null;
    }
    // pseudo: aggregate each field key across members (first-seen order)
    const byKey = new Map<string, string[]>();
    for (const n of nodes)
      for (const [k, v] of n.fields) {
        let list = byKey.get(k);
        if (!list) byKey.set(k, (list = []));
        list.push(v);
      }
    if (!byKey.size) return null;
    const rows: [string, string][] = [];
    for (const [k, values] of byKey) {
      const merged = aggregate(values, rules[k] ?? fallback);
      if (merged) rows.push([k, merged]);
    }
    return rows.length ? { kind: "kv", rows: rows.slice(0, 4) } : null;
  };
}

/** rgui's default data-merge summary (mode for every field) */
export const defaultSummarize: SummarizeFn = fieldSummarize();
