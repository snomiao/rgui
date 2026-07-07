# @snomiao/rgui

**A framework-agnostic "readable-grid" UI library.** Every element snaps to a screen-adaptive grid and stays legible at any zoom level — whatever cannot be drawn readably is replaced by a readable abstraction via semantic-zoom level-of-detail (LOD). Ships a Canvas 2D renderer today, with a WebGPU renderer behind the same interface next. The only runtime dependencies are `d3-zoom` and `d3-selection`.

---

## rgui とは何か

rgui は「readable-grid」という一つの原則を UI 全体に貫くための、フレームワーク非依存のライブラリである。原則は次の二つに要約される。

1. **全要素が画面適応型の readable grid に snap する。** グリッドの主線間隔は常に一定の可読ピクセル幅を保つよう 1-2-5 の刻み梯子で選び直され、ノードやポートはその最小グリッドへ吸着する。したがって、どれだけ拡大・縮小しても要素同士の間隔が「読める密度」から外れない。
2. **zoom しても常に可読である。** ある要素がそのズーム率で可読に描けなくなった瞬間、その要素は消えるのではなく、可読な抽象へ置換される。これが semantic-zoom LOD であり、細部が潰れる寸前でノードは擬似ノード (pseudo-node) へ折り畳まれ、近接した要素群は位置に基づいて一つの塊へ併合される。読めないものは画面に残さない、という思想である。

描画は現在 Canvas 2D 実装だが、レンダラは同一インターフェース越しに差し替え可能で、WebGPU 実装を次段に予定している。マウント先は任意の `<canvas>` であり、React・Vue・Svelte・素の DOM のいずれからも同じ API で利用できる。

## インストール

```bash
bun add @snomiao/rgui
# または
npm install @snomiao/rgui
```

`d3-zoom` / `d3-selection` は依存として自動的に導入される。パッケージは pure ESM であり、バンドラ (Vite・webpack・esbuild 等) もしくは Node.js の ESM から利用する。

## クイックスタート

```ts
import rgui, { demoGraph, type Graph } from "@snomiao/rgui";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;

// Build a dataflow graph in world coordinates, or use demoGraph() to start.
const graph: Graph = {
  nodes: [
    {
      id: "src",
      title: "Camera",
      category: "source",
      x: -240, y: -80, w: 200,
      inputs: [],
      outputs: [{ id: "image", label: "image", kind: "image" }],
      fields: [["device", "Default camera"]],
    },
    {
      id: "sink",
      title: "Vision model",
      category: "model",
      x: 80, y: -80, w: 220,
      inputs: [{ id: "image", label: "image", kind: "image" }],
      outputs: [{ id: "labels", label: "labels", kind: "text" }],
      fields: [["model", "YOLOS-tiny"]],
    },
  ],
  edges: [
    { from: { node: "src", port: "image" }, to: { node: "sink", port: "image" } },
  ],
};

// Mount a readable-grid viewer on the canvas.
const viewer = rgui(canvas, {
  graph,                        // or demoGraph() for a ready-made pipeline
  rule: { collapsePx: 48 },     // tune the readability thresholds (see below)
});

// Pan/zoom (d3-zoom), grid-snapped node dragging, and semantic-zoom LOD
// are all wired up automatically. Clean up when done:
viewer.destroy();
```

`rgui(canvas, options)` が返す `Rgui` オブジェクトは、現在のビュー変換 `view`、解決済みルール `rule`、`graph` の読み書き、再描画要求 `invalidate()`、破棄 `destroy()` を備える。`demoGraph()` は動作確認用の完成済みパイプラインを返すため、まずはこれを渡して挙動を確認するとよい。

## RgRule — 可読性しきい値のカスタマイズ

rgui のあらゆる可読性判定は、単一の `RgRule` オブジェクトに集約されている。用途 (密な DAW 風パッチング、疎なマインドマップ、ダッシュボード等) に応じてこれらの数値を調整する。`options.rule` には部分指定を渡せばよく、未指定項目は既定値へフォールバックする。

| プロパティ | 既定値 | 意味 |
| --- | --- | --- |
| `minGridPx` | `48` | 主グリッド点の画面上最小間隔 (px)。readable grid の基準。 |
| `ladder` | `[1, 2, 5]` | 一桁 (decade) 内のグリッド刻み梯子。10 の約数で昇順であること。 |
| `collapsePx` | `56` | ノードがこの画面高さを下回ると擬似ノードへ折り畳まれる (px)。 |
| `fieldMinPx` | `9` | この行高さ (px) を下回るとノード内のフィールド文字列を隠す。 |
| `portLabelMinPx` | `6` | この行高さ (px) を下回るとポートラベルを隠す。 |
| `clusterGapPx` | `24` | 位置に基づくクラスタ併合の画面空間ギャップ予算 (px)。 |
| `clusterGapConnectedPx` | `40` | 結線されたノードは、より大きなギャップ越しでも併合される (px)。 |
| `pseudo` | `{ w: 200, headerH: 26, rowH: 18, pad: 8 }` | 擬似ノードの画面 px 寸法 (画面上で一定サイズ)。 |
| `declutterMarginPx` | `10` | 整理後の擬似ノード間に確保する最小ギャップ (px)。 |

`DEFAULT_RULE` と `resolveRule(partial)` はエクスポートされており、既定値の参照や部分ルールの解決を独立して行える。

## API 概観

デフォルトエクスポートは `createRgui` (別名 `rgui`) である。加えて、UI を組まずに rg の数理・モデル・描画部品を個別利用するための名前付きエクスポートを提供する。全て framework 非依存の純関数・純データである。

- **高レベル**: `createRgui`, 型 `Rgui`, `RguiOptions`
- **グリッド数理** (`core/grid`): `readableStep`, `gridLevels`, `finerStep`, `gridRange`, `snap`, `worldToScreen`, `screenToWorld`, 型 `ViewTransform`, `GridLevel`
- **ルール** (`core/rule`): `DEFAULT_RULE`, `resolveRule`, 型 `RgRule`
- **グラフモデル** (`core/graph`): `demoGraph`, `nodeHeight`, `inputPortPos`, `outputPortPos`, 定数 `NODE_HEADER_H` / `NODE_ROW_H` / `NODE_PAD` / `PORT_R`, 型 `Graph`, `GraphNode`, `Edge`, `Port`, `SignalKind`, `NodeCategory`
- **semantic-zoom LOD** (`core/lod`): `buildRenderGraph`, `pseudoRect`, `pseudoPortPos`, `endpointPos`, 型 `RenderGraph`, `PseudoNode`, `RenderEdge`, `EndpointRef`
- **レンダラ** (`render`): `createCanvas2DRenderer`, `createGridDotsLayer`, `gridDotsLayer`, `drawGraph`, `KIND_COLOR`, 型 `DrawLayer`, `GridRenderer`

TypeScript 型定義は同梱される。ソースを直接参照したい場合は `@snomiao/rgui/src` サブパスから生の TypeScript を取得できる。

## ロードマップ

- **WebGPU レンダラ** — 現行の Canvas 2D と同一インターフェース越しに差し替え可能な描画バックエンド。
- **自動レイアウト** — ノードグラフの初期配置と再配置。
- LOD 併合戦略の拡充と、より大規模なグラフへのスケーリング。

## ライセンス

MIT © snomiao
