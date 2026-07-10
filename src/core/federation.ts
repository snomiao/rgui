import type { Edge, Graph, GraphNode, NodeCategory, Port, SignalKind } from "./graph.js";
import type { SignalSpec } from "./signal.js";
import { terminalPreviewDraw, type TerminalPreview } from "../render/terminalPreview.js";

export const FEDERATED_GRAPH_KIND = "rgui-federated-graph";
export const FEDERATED_GRAPH_SCHEMA = "org.rgui.graph.v1";

export interface FederatedProducer {
  app: string;
  origin: string;
  deviceId?: string;
  peerId?: string;
  workspace?: string;
  label?: string;
}

export interface FederatedPort {
  id: string;
  label?: string;
  kind: SignalKind;
  signal?: Partial<SignalSpec>;
}

export interface FederatedNode {
  /** Globally namespaced id, e.g. "otoji://room/browser/plaintext". */
  id: string;
  app: string;
  type: string;
  title: string;
  category?: NodeCategory;
  inputs?: FederatedPort[];
  outputs?: FederatedPort[];
  pos?: { x: number; y: number; z?: number };
  size?: { w: number; h?: number; scale?: number };
  owner?: string;
  status?: string;
  parent?: string;
  renderHints?: Record<string, unknown>;
  configPublic?: Record<string, unknown>;
  private?: boolean;
}

export interface FederatedEdge {
  id?: string;
  source: { node: string; port: string; type?: SignalKind };
  target: { node: string; port: string; type?: SignalKind };
  signal?: Partial<SignalSpec>;
  status?: "active" | "proposed" | "readonly" | "blocked" | (string & {});
  label?: string;
}

export interface FederatedGraphEnvelope {
  kind: typeof FEDERATED_GRAPH_KIND;
  schema: typeof FEDERATED_GRAPH_SCHEMA;
  producer: FederatedProducer;
  revision: string | number;
  ts: number;
  graph: {
    nodes: FederatedNode[];
    edges: FederatedEdge[];
  };
  capabilities?: {
    nodeTypes?: string[];
    portTypes?: SignalKind[];
    previewKinds?: string[];
  };
  view?: { x: number; y: number; k: number };
}

export interface FederationClampOptions {
  maxNodes?: number;
  maxEdges?: number;
  maxTextLength?: number;
  maxCoord?: number;
  maxSize?: number;
  minSize?: number;
}

const DEFAULT_CLAMP: Required<FederationClampOptions> = {
  maxNodes: 512,
  maxEdges: 2048,
  maxTextLength: 160,
  maxCoord: 1_000_000,
  maxSize: 8192,
  minSize: 64,
};

const DEFAULT_NODE_W = 256;
const DEFAULT_NODE_H = 128;

export const FEDERATED_DEMO_CHAIN_IDS = {
  plain: federatedNodeId("otoji://browser", "plaintext-node"),
  codex: federatedNodeId("ay://agent-yes", "codex-agent"),
  diff: federatedNodeId("rgui://demo", "text-diff-node"),
  filter: federatedNodeId("rgui://demo", "filter-added-text"),
  translate: federatedNodeId("otoji://browser", "browser-translator-en-ja"),
  tts: federatedNodeId("otoji://browser", "in-browser-tts-node"),
} as const;

export function federatedNodeId(namespace: string, localId: string): string {
  const ns = namespace.trim().replace(/\/+$/, "");
  const id = encodeURIComponent(localId.trim().replace(/^\/+/, ""));
  return `${ns}/${id}`;
}

export function federatedOriginOf(nodeId: string): string {
  const urlish = nodeId.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i);
  if (urlish) return urlish[0]!;
  const slash = nodeId.indexOf("/");
  return slash >= 0 ? nodeId.slice(0, slash) : nodeId;
}

/**
 * Extract and sanitize a node's terminal preview (`renderHints.preview` with
 * `kind: "terminal"`). Lines are capped in count and length so a remote feed
 * can't stuff megabytes of scrollback into a render hint.
 */
export function federatedTerminalPreview(
  n: Pick<FederatedNode, "renderHints" | "private">,
  opts: { maxLines?: number; maxTextLength?: number } = {},
): TerminalPreview | undefined {
  if (n.private) return undefined;
  const raw = n.renderHints?.preview;
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Partial<TerminalPreview>;
  if (p.kind !== "terminal") return undefined;
  const maxLines = opts.maxLines ?? 24;
  const maxText = opts.maxTextLength ?? DEFAULT_CLAMP.maxTextLength;
  return {
    kind: "terminal",
    title: typeof p.title === "string" ? clampText(p.title, maxText) : undefined,
    status: typeof p.status === "string" ? clampText(p.status, maxText) : undefined,
    lines: Array.isArray(p.lines)
      ? p.lines.slice(-maxLines).map((ln) => clampText(String(ln), maxText))
      : undefined,
  };
}

/**
 * Extract a federated node's live-embed URL (`renderHints.embed.url`) — the
 * publisher's own single-node live view, meant to be glued over the node rect
 * as a sandboxed iframe overlay. Only http(s) URLs pass; anything else
 * (javascript:, data:) from an untrusted feed is dropped, as is the hint on
 * `private` nodes.
 */
export function federatedEmbedUrl(
  n: Pick<FederatedNode, "renderHints" | "private">,
): string | undefined {
  const raw = (n.renderHints?.embed as { url?: unknown } | undefined)?.url;
  if (typeof raw !== "string" || n.private) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function isFederatedGraphEnvelope(value: unknown): value is FederatedGraphEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<FederatedGraphEnvelope>;
  return (
    v.kind === FEDERATED_GRAPH_KIND &&
    v.schema === FEDERATED_GRAPH_SCHEMA &&
    !!v.producer &&
    typeof v.producer === "object" &&
    !!v.graph &&
    Array.isArray(v.graph.nodes) &&
    Array.isArray(v.graph.edges)
  );
}

export function clampFederatedGraph(
  env: FederatedGraphEnvelope,
  opts: FederationClampOptions = {},
): FederatedGraphEnvelope {
  const o = { ...DEFAULT_CLAMP, ...opts };
  const nodeIds = new Set<string>();
  const nodes: FederatedNode[] = [];
  for (const raw of env.graph.nodes.slice(0, o.maxNodes)) {
    const id = clampText(raw.id, o.maxTextLength);
    if (!id || nodeIds.has(id)) continue;
    nodeIds.add(id);
    nodes.push({
      ...raw,
      id,
      app: clampText(raw.app, o.maxTextLength) || "unknown",
      type: clampText(raw.type, o.maxTextLength) || "node",
      title: raw.private
        ? "Private node"
        : clampText(raw.title, o.maxTextLength) || raw.type || "node",
      owner: raw.owner ? clampText(raw.owner, o.maxTextLength) : undefined,
      status: raw.status ? clampText(raw.status, o.maxTextLength) : undefined,
      parent: raw.parent ? clampText(raw.parent, o.maxTextLength) : undefined,
      pos: {
        x: clampNumber(raw.pos?.x, -o.maxCoord, o.maxCoord, 0),
        y: clampNumber(raw.pos?.y, -o.maxCoord, o.maxCoord, 0),
        z: raw.pos?.z == null ? undefined : clampNumber(raw.pos.z, -o.maxCoord, o.maxCoord, 0),
      },
      size: {
        w: clampNumber(raw.size?.w, o.minSize, o.maxSize, DEFAULT_NODE_W),
        h: raw.size?.h == null ? undefined : clampNumber(raw.size.h, o.minSize, o.maxSize, DEFAULT_NODE_H),
        scale:
          raw.size?.scale == null
            ? undefined
            : clampNumber(raw.size.scale, 0.25, 8, 1),
      },
      inputs: clampPorts(raw.inputs, o.maxTextLength),
      outputs: clampPorts(raw.outputs, o.maxTextLength),
      configPublic: raw.private ? undefined : clampPublicRecord(raw.configPublic, o.maxTextLength),
      renderHints: raw.private ? undefined : raw.renderHints,
    });
  }

  const finalNodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes)
    if (n.parent && !finalNodeIds.has(n.parent)) n.parent = undefined;

  const edges = env.graph.edges
    .slice(0, o.maxEdges)
    .filter((e) => nodeIds.has(e.source.node) && nodeIds.has(e.target.node))
    .map((e) => ({
      ...e,
      id: e.id ? clampText(e.id, o.maxTextLength) : undefined,
      label: e.label ? clampText(e.label, o.maxTextLength) : undefined,
      status: e.status ? clampText(e.status, o.maxTextLength) : undefined,
      source: {
        node: e.source.node,
        port: clampText(e.source.port, o.maxTextLength),
        type: e.source.type,
      },
      target: {
        node: e.target.node,
        port: clampText(e.target.port, o.maxTextLength),
        type: e.target.type,
      },
    }));

  return {
    ...env,
    producer: {
      ...env.producer,
      app: clampText(env.producer.app, o.maxTextLength) || "unknown",
      origin: clampText(env.producer.origin, o.maxTextLength) || "unknown",
      label: env.producer.label ? clampText(env.producer.label, o.maxTextLength) : undefined,
    },
    revision: typeof env.revision === "number" ? env.revision : clampText(String(env.revision), o.maxTextLength),
    ts: Number.isFinite(env.ts) ? env.ts : Date.now(),
    graph: { nodes, edges },
  };
}

export function federatedGraphToRgui(
  env: FederatedGraphEnvelope,
  opts: { container?: boolean; offset?: { x: number; y: number } } = {},
): Graph {
  const safe = clampFederatedGraph(env);
  const offset = opts.offset ?? { x: 0, y: 0 };
  const nodes: GraphNode[] = [];
  const containerId = federatedNodeId(
    `${safe.producer.app}://${safe.producer.origin}`,
    "federated-root",
  );

  if (opts.container !== false) {
    nodes.push({
      id: containerId,
      title: safe.producer.label ?? `${safe.producer.app} · ${safe.producer.origin}`,
      category: "federated",
      x: offset.x - 96,
      y: offset.y - 96,
      w: 384,
      h: 128,
      inputs: [],
      outputs: [],
      fields: [
        ["schema", safe.schema],
        ["revision", String(safe.revision)],
      ],
      pinned: true,
    });
  }

  for (const n of safe.graph.nodes) {
    const preview = federatedTerminalPreview(n);
    nodes.push({
      id: n.id,
      title: n.title,
      category: n.category ?? n.app,
      x: (n.pos?.x ?? 0) + offset.x,
      y: (n.pos?.y ?? 0) + offset.y,
      z: n.pos?.z,
      w: n.size?.w ?? DEFAULT_NODE_W,
      h: n.size?.h ?? DEFAULT_NODE_H,
      scale: n.size?.scale,
      parent: n.parent ?? (opts.container === false ? undefined : containerId),
      inputs: (n.inputs ?? []).map(toRguiPort),
      outputs: (n.outputs ?? []).map(toRguiPort),
      fields: federatedNodeFields(n),
      fieldRules: { app: "set", owner: "set", status: "set" },
      pinned: true,
      remote: true,
      bg: n.private ? "#3a3036" : undefined,
      draw: preview ? terminalPreviewDraw({ ...preview, title: preview.title ?? n.title }) : undefined,
    });
  }

  const edges: Edge[] = safe.graph.edges.map((e) => ({
    from: { node: e.source.node, port: e.source.port },
    to: { node: e.target.node, port: e.target.port },
    dashed: e.status === "proposed" || e.status === "readonly",
    label: e.label ?? e.status,
  }));

  return { nodes, edges };
}

export function federatedDemoChain(now = Date.now()): FederatedGraphEnvelope {
  const ids = FEDERATED_DEMO_CHAIN_IDS;

  const textIn: FederatedPort = { id: "text-in", label: "text", kind: "text", signal: { measure: "extensive", ownership: "copy", fanout: "broadcast", merge: "concat" } };
  const textOut: FederatedPort = { id: "text-out", label: "text", kind: "text", signal: { measure: "extensive", ownership: "copy", fanout: "broadcast", merge: "concat" } };

  const nodes: FederatedNode[] = [
    demoNode(ids.plain, "otoji", "plaintext-node", "Plaintext", -640, 0, [], [textOut], "otoji:browser"),
    {
      ...demoNode(ids.codex, "agent-yes", "codex-agent", "Codex Agent", -320, 0, [textIn], [textOut], "agent-yes:codex"),
      renderHints: {
        preview: {
          kind: "terminal",
          title: "codex · ~/ws/demo",
          status: "active",
          lines: [
            "❯ codex --full-auto",
            "• Reading plaintext from text-in",
            "• Editing: fix typos, tighten prose",
            "• Ran bun test — 12 pass",
            "• Writing edited text to text-out",
            "▌",
          ],
        } satisfies TerminalPreview,
      },
    },
    demoNode(ids.diff, "rgui", "text-diff-node", "Text Diff", 0, 0, [textIn], [textOut], "rgui:demo"),
    demoNode(ids.filter, "rgui", "filter-node", "Filter: added text", 320, 0, [textIn], [textOut], "rgui:demo"),
    demoNode(ids.translate, "otoji", "browser-translator-api", "Browser Translator en to ja", 640, 0, [textIn], [textOut], "otoji:browser"),
    demoNode(ids.tts, "otoji", "in-browser-tts-node", "In-browser TTS", 960, 0, [textIn], [{ id: "audio-out", label: "audio", kind: "audio", signal: { measure: "extensive", ownership: "clone", fanout: "broadcast", merge: "concat" } }], "otoji:browser"),
  ];

  return {
    kind: FEDERATED_GRAPH_KIND,
    schema: FEDERATED_GRAPH_SCHEMA,
    producer: { app: "rgui", origin: "demo", label: "Cross-system demo chain" },
    revision: "demo-chain-v0",
    ts: now,
    graph: {
      nodes,
      edges: [
        demoEdge(ids.plain, "text-out", ids.codex, "text-in", "plaintext"),
        demoEdge(ids.codex, "text-out", ids.diff, "text-in", "agent output"),
        demoEdge(ids.diff, "text-out", ids.filter, "text-in", "diff"),
        demoEdge(ids.filter, "text-out", ids.translate, "text-in", "added only"),
        demoEdge(ids.translate, "text-out", ids.tts, "text-in", "ja text"),
      ],
    },
    capabilities: {
      nodeTypes: ["plaintext-node", "codex-agent", "text-diff-node", "filter-node", "browser-translator-api", "in-browser-tts-node"],
      portTypes: ["text", "audio"],
      previewKinds: ["text", "terminal", "speech"],
    },
  };
}

export function federatedDemoChainGraph(): Graph {
  return federatedGraphToRgui(federatedDemoChain(), { container: true });
}

function demoNode(
  id: string,
  app: string,
  type: string,
  title: string,
  x: number,
  y: number,
  inputs: FederatedPort[],
  outputs: FederatedPort[],
  owner: string,
): FederatedNode {
  return {
    id,
    app,
    type,
    title,
    category: app,
    owner,
    status: "readonly",
    pos: { x, y },
    size: { w: 256, h: 128 },
    inputs,
    outputs,
    configPublic: { demo: true },
  };
}

function demoEdge(
  sourceNode: string,
  sourcePort: string,
  targetNode: string,
  targetPort: string,
  label: string,
): FederatedEdge {
  return {
    source: { node: sourceNode, port: sourcePort, type: "text" },
    target: { node: targetNode, port: targetPort, type: "text" },
    status: "readonly",
    label,
    signal: { measure: "extensive", ownership: "copy", fanout: "broadcast", merge: "concat" },
  };
}

function toRguiPort(p: FederatedPort): Port {
  return {
    id: p.id,
    label: p.label ?? p.id,
    kind: p.kind,
    ...p.signal,
  };
}

function federatedNodeFields(n: FederatedNode): [string, string][] {
  const out: [string, string][] = [
    ["app", n.app],
    ["type", n.type],
  ];
  if (n.owner) out.push(["owner", n.owner]);
  if (n.status) out.push(["status", n.status]);
  if (n.private) out.push(["privacy", "redacted"]);
  return out;
}

function clampPorts(ports: FederatedPort[] | undefined, maxText: number): FederatedPort[] {
  return (ports ?? []).slice(0, 64).map((p) => ({
    ...p,
    id: clampText(p.id, maxText),
    label: p.label ? clampText(p.label, maxText) : undefined,
    kind: clampText(p.kind, maxText) as SignalKind,
  })).filter((p) => p.id && p.kind);
}

function clampPublicRecord(
  record: Record<string, unknown> | undefined,
  maxText: number,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record).slice(0, 32)) {
    const key = clampText(k, maxText);
    if (!key) continue;
    out[key] = typeof v === "string" ? clampText(v, maxText) : v;
  }
  return out;
}

function clampText(value: string, max: number): string {
  return String(value ?? "").slice(0, max);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}
