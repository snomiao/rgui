import { describe, expect, test } from "bun:test";
import {
  FEDERATED_GRAPH_KIND,
  FEDERATED_GRAPH_SCHEMA,
  FEDERATED_DEMO_CHAIN_IDS,
  clampFederatedGraph,
  federatedDemoChain,
  federatedGraphToRgui,
  federatedNodeId,
  federatedOriginOf,
  federatedTerminalPreview,
  isFederatedGraphEnvelope,
  type FederatedGraphEnvelope,
} from "./federation.js";

describe("federated graph envelope", () => {
  test("recognizes the v1 envelope shape", () => {
    const env = federatedDemoChain(123);
    expect(isFederatedGraphEnvelope(env)).toBe(true);
    expect(isFederatedGraphEnvelope({ ...env, schema: "old" })).toBe(false);
    expect(env.kind).toBe(FEDERATED_GRAPH_KIND);
    expect(env.schema).toBe(FEDERATED_GRAPH_SCHEMA);
  });

  test("namespaced ids preserve the origin boundary", () => {
    const id = federatedNodeId("otoji://browser/", "plain text");
    expect(id).toBe("otoji://browser/plain%20text");
    expect(federatedOriginOf(id)).toBe("otoji://browser");
    expect(federatedOriginOf("agent-yes/local")).toBe("agent-yes");
  });

  test("clamps untrusted text, geometry, counts, and private config", () => {
    const env: FederatedGraphEnvelope = {
      kind: FEDERATED_GRAPH_KIND,
      schema: FEDERATED_GRAPH_SCHEMA,
      producer: { app: "otoji", origin: "room" },
      revision: "r",
      ts: NaN,
      graph: {
        nodes: [
          {
            id: "n1-long",
            app: "otoji",
            type: "secret-node",
            title: "secret title",
            private: true,
            pos: { x: 99999, y: -99999 },
            size: { w: 99999, h: 1, scale: 99 },
            inputs: [{ id: "in".repeat(20), kind: "text", label: "label".repeat(20) }],
            outputs: [],
            configPublic: { token: "do not leak" },
          },
          {
            id: "n2",
            app: "agent-yes",
            type: "agent",
            title: "agent",
            pos: { x: 0, y: 0 },
            size: { w: 128 },
            inputs: [],
            outputs: [{ id: "out", kind: "text" }],
          },
        ],
        edges: [
          { source: { node: "n2", port: "out" }, target: { node: "n1-long", port: "in" } },
          { source: { node: "missing", port: "out" }, target: { node: "n1-long", port: "in" } },
        ],
      },
    };
    const safe = clampFederatedGraph(env, {
      maxTextLength: 8,
      maxCoord: 100,
      maxSize: 512,
      minSize: 64,
    });
    expect(typeof safe.ts).toBe("number");
    expect(safe.graph.nodes[0]!.title).toBe("Private node");
    expect(safe.graph.nodes[0]!.configPublic).toBeUndefined();
    expect(safe.graph.nodes[0]!.pos).toEqual({ x: 100, y: -100, z: undefined });
    expect(safe.graph.nodes[0]!.size).toEqual({ w: 512, h: 64, scale: 8 });
    expect(safe.graph.nodes[0]!.inputs![0]!.id).toBe("inininin");
    expect(safe.graph.edges).toHaveLength(1);
  });

  test("converts a federated envelope into a read-only rgui mirror", () => {
    const graph = federatedGraphToRgui(federatedDemoChain(123));
    expect(graph.nodes.map((n) => n.id)).toContain("otoji://browser/plaintext-node");
    expect(graph.nodes.map((n) => n.id)).toContain("ay://agent-yes/codex-agent");
    expect(graph.edges).toHaveLength(5);
    expect(graph.edges.every((e) => e.dashed)).toBe(true);
    expect(graph.nodes.find((n) => n.id === "ay://agent-yes/codex-agent")?.pinned).toBe(true);
  });

  test("terminal preview render hint becomes a TUI draw hook", () => {
    const graph = federatedGraphToRgui(federatedDemoChain(123));
    const codex = graph.nodes.find((n) => n.id === FEDERATED_DEMO_CHAIN_IDS.codex);
    expect(typeof codex?.draw).toBe("function");
    // nodes without the hint keep the default field-card rendering
    const plain = graph.nodes.find((n) => n.id === FEDERATED_DEMO_CHAIN_IDS.plain);
    expect(plain?.draw).toBeUndefined();
  });

  test("federatedTerminalPreview sanitizes hostile hints and respects privacy", () => {
    expect(federatedTerminalPreview({ renderHints: { preview: { kind: "text" } } })).toBeUndefined();
    expect(federatedTerminalPreview({ renderHints: {} })).toBeUndefined();
    expect(
      federatedTerminalPreview({
        private: true,
        renderHints: { preview: { kind: "terminal", lines: ["secret"] } },
      }),
    ).toBeUndefined();
    const p = federatedTerminalPreview(
      {
        renderHints: {
          preview: {
            kind: "terminal",
            title: "t".repeat(500),
            status: "active",
            lines: Array.from({ length: 100 }, (_, i) => `line ${i} ` + "x".repeat(500)),
          },
        },
      },
      { maxLines: 5, maxTextLength: 16 },
    );
    expect(p?.kind).toBe("terminal");
    expect(p?.title).toHaveLength(16);
    expect(p?.lines).toHaveLength(5);
    expect(p?.lines?.[0]).toBe("line 95 xxxxxxxx");
    expect(p?.lines?.every((ln) => ln.length <= 16)).toBe(true);
  });

  test("demo chain matches the requested cross-system text path", () => {
    const env = federatedDemoChain(123);
    expect(FEDERATED_DEMO_CHAIN_IDS.codex).toBe("ay://agent-yes/codex-agent");
    expect(env.graph.nodes.map((n) => n.type)).toEqual([
      "plaintext-node",
      "codex-agent",
      "text-diff-node",
      "filter-node",
      "browser-translator-api",
      "in-browser-tts-node",
    ]);
    expect(env.graph.edges.map((e) => `${e.source.node}>${e.target.node}`)).toEqual([
      "otoji://browser/plaintext-node>ay://agent-yes/codex-agent",
      "ay://agent-yes/codex-agent>rgui://demo/text-diff-node",
      "rgui://demo/text-diff-node>rgui://demo/filter-added-text",
      "rgui://demo/filter-added-text>otoji://browser/browser-translator-en-ja",
      "otoji://browser/browser-translator-en-ja>otoji://browser/in-browser-tts-node",
    ]);
  });
});
