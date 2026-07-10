# rgui federated graph v1

`org.rgui.graph.v1` is a transport-agnostic envelope for showing graphs from
several systems in one rgui canvas. It is deliberately not rgui canvas state:
each app keeps its own authoritative model, publishes a small semantic graph,
and adapts remote graphs into read-only rgui mirrors locally.

```ts
import {
  FEDERATED_GRAPH_SCHEMA,
  FEDERATED_DEMO_CHAIN_IDS,
  federatedGraphToRgui,
  federatedDemoChain,
} from "@snomiao/rgui";
```

## Envelope

```ts
{
  kind: "rgui-federated-graph",
  schema: "org.rgui.graph.v1",
  producer: { app: "otoji", origin: "https://otoji.org", deviceId, workspace },
  revision: "42",
  ts: Date.now(),
  graph: { nodes, edges },
  capabilities: { nodeTypes, portTypes, previewKinds }
}
```

Node ids must be globally namespaced, for example
`otoji://room/browser/plaintext-node` or `ay://host/pid/38149`. The display label
is separate from identity. Remote data is untrusted; consumers should call
`clampFederatedGraph()` or `federatedGraphToRgui()`, which clamps geometry, text,
node count, edge count, and redacts `private` node config.

## Preview and Runtime

Graph structure and previews are separate channels. A graph snapshot should say
that a node exists and which ports it exposes; terminal bytes, image previews,
speech state, or browser media should be subscribed to per node with an app-level
preview protocol such as `fg-preview-sub` / `fg-preview`.

The default mutability is read-only. Cross-app runtime edges should stay visual
until both systems explicitly grant compatible transport and execution ACLs.

One lightweight preview IS allowed inline: `renderHints.preview` with
`kind: "terminal"` renders the node as a miniature TUI card (status-dot title
bar + dark monospace tail), exactly like an agent node on agent-yes.com/r/.
Publishers must only put already-redacted lines here; consumers get the hint
sanitized (`federatedTerminalPreview()` caps line count and length, and drops
it entirely on `private` nodes) and `federatedGraphToRgui()` attaches the
`terminalPreviewDraw()` hook automatically.

```ts
node.renderHints = {
  preview: {
    kind: "terminal",
    title: "codex · ~/ws/demo",   // title-bar text (defaults to node title)
    status: "active",              // active | needs_input | stuck | exited | idle
    lines: ["❯ codex --full-auto", "• Ran bun test — 12 pass"], // newest last
  },
};
```

## Federation Infrastructure

How two rgui apps (e.g. otoji.org and agent-yes.com) render each other's graphs
for real. Every leg speaks the same v1 envelope; only the transport differs.

**Publish** — each app exposes its envelope on a capability URL:

- Server-backed apps (agent-yes): `GET /api/graph?token=…` — token-gated,
  `Access-Control-Allow-Origin: *`, redacted at the source (the publisher owns
  its privacy policy; consumers only ever see what it chose to say).
- Browser-only apps (otoji): the room host pushes the envelope over its
  existing signaling WebSocket (`fed-graph` message, debounced); the room's
  Durable Object stores it and serves `GET /signal/{room}/graph` with open
  CORS. The room code is the read capability — the same code already grants a
  WS join. Node ids are namespaced `otoji://room/{room}/{nodeId}`.

**Subscribe** — consumers poll the URL (5s, revision-gated: unchanged
`revision` = no re-render; unreachable feed = keep last good copy and mark
stale) or hold a WebRTC data channel / SSE stream for push. Polling is the v1
floor every implementation must support; push is an upgrade, not a requirement.

**Authority & merge** — the node id namespace is the authority key:
`ay://agent-yes/*` nodes are authoritative from the agent-yes feed,
`otoji://…/*` from otoji. Merge order is local < feeds < baked stubs, deduped
by id, so a stub (`ay://agent-yes/codex-agent` baked into a demo chain) is
replaced by the live node when its feed is connected. Cross-app edges reference
ids in both namespaces and survive because ids are stable.

Consumers SHOULD enforce namespace ownership at the app-scheme level: a feed
may only render nodes whose id scheme matches its `producer.app` (an otoji
feed can't inject `ay://…` nodes). Enforcement is per app scheme, not
`producer.origin`, because origin formats differ across publishers (URL vs
name). Foreign-namespace entries become invisible stubs; their cross-namespace
edges still land once the authoritative feed supplies the node.

**Preview ladder** — three fidelity rungs per remote node, in cost order:

1. `fields` (app/type/owner/status) — always present, plain card.
2. `renderHints.preview { kind: "terminal", … }` — inline low-rate preview,
   redrawn per poll; rendered by `terminalPreviewDraw()` (below).
3. `renderHints.embed { url }` — a consumer MAY glue a sandboxed cross-origin
   iframe (the publisher's own single-node live view, e.g.
   `agent-yes.com/r/#node=<id>&embed`) over the node rect as an rgui overlay
   (`scale: "fit"`), falling back to rung 2 when hidden or too small. This is
   how a node shows the publisher's REAL live UI — same pixels, zero protocol.

**Visual legend** — rgui marks federation state on the node border:
`remote` (yellow halo) = a read-only mirror of someone else's node;
`shared` (green halo) = a LOCAL node this app is publishing outward. Both are
`GraphNode` props (`boolean` or live getter).

**Node-scoped shares** — beyond whole-graph feeds, a publisher can mint a
scoped share for ONE node (e.g. agent-yes right-click → "share this node" →
its own e2ee room exposing a single agent, host-enforced, optional
write-permission). The share link is just a smaller-scoped capability URL;
everything above (authority, preview ladder, mutation rules) applies
unchanged.

**Mutation** — the envelope is read-only end to end. Writes (e.g. sending a
prompt into an agent-yes node) go through the publisher's own API with its own
auth, never through the envelope. The embed view is the natural surface for
this: agent-yes embeds ship a prompt bar that POSTs to the publisher's
`/api/send` with the embed token, so an embed holder can drive the real agent;
publishers should offer a read-only variant (append `&ro` to the embed URL)
for display-only mirrors.

## Demo Chain

`federatedDemoChain()` returns the first cross-system demo path:

```txt
plaintext-node (otoji browser)
  -> codex-agent (agent-yes)
  -> text-diff-node
  -> filter-node (added text only)
  -> browser-translator-api (en to ja, otoji browser)
  -> in-browser-tts-node (otoji browser)
```

Use `federatedDemoChainGraph()` for a ready-made read-only rgui `Graph`.
