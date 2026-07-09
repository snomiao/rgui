# The rgui signal algebra

`MergeRule` answers *"how do a node's field values combine when nodes renormalize
into one block?"*. This answers the same question one level down — for the data on
the **ports** — and adds the question renormalization never had to ask: what
happens on the way **out**.

rgui does not execute graphs. Its job here is to let a port **declare** its
algebra, **validate** the wiring against it, and **render** the difference. The
host (otoji, sflow, your own scheduler) executes.

## Three questions, three owners

| question | field | owned by | why |
|---|---|---|---|
| is `+` meaningful across parallel sources? | `measure: "extensive" \| "intensive"` | the port | a property of the data |
| **may** this value be duplicated? | `share: "copy" \| "clone" \| "move"` | the **producing port** (not overridable) | only the node emitting a value knows whether it hands out a coordinate or a MediaStream handle |
| is it duplicated **here**, or divided? | `fanout: "broadcast" \| "split" \| "route"` | the **fan-out group** | a topology decision — the same audio port broadcasts to a recorder in one graph and round-robins across a worker pool in another |
| what **share** does this wire take? | `Edge.weight` | the **edge** | only the shares may differ within a group; the policy may not |

`share` and `fanout` are deliberately separate. One says what the data **is** (a
capability, intrinsic); the other says what this particular topology **does** with
it (a policy). Conflating them cannot express *"a 4K frame may be copied, but
broadcasting it to three consumers on three machines means serializing it three
times."*

The policy belongs to the **group** — the set of edges leaving one output port —
and not to any single edge, because conservation is a property of the whole
division. You cannot have one edge of a group broadcast while another splits. So:

- the **port** carries the group's default (`Port.fanout`),
- the **graph** overrides it per group (`Graph.fanout["nodeId.portId"]`),
- the **edge** apportions the shares within a split (`Edge.weight`).

## `share` — the capability

This is Rust's `Copy` / `Clone` / move, and for the same reason.

| `share` | duplication | examples |
|---|---|---|
| `copy` | **free** | coordinates, labels, config, an STT transcript |
| `clone` | **legal, but costs** | a 4K frame, a PCM chunk — broadcasting to 3 machines serializes it 3× |
| `move` | **impossible or forbidden** | money, a token budget, a work item (copying double-spends it); a GPU buffer, a file descriptor, a MediaStream handle (copying can't leave home) |

The single constraint: **a `move` value may never `broadcast`.** Everything else is
allowed — splitting a copyable value is a load-balancing choice, not a safety one,
which is exactly why `jsonl` is `share: "copy"` yet `fanout: "split"`.

### Where "single-to-single by default" bites

`signalConnectionGuard(() => graph)` plugs into `createRgui({ isValidConnection })`
and refuses the second edge off a **broadcasting `move` port** — and nothing else.
A `clone` fan-out is legal (you get a warning about the cost); a `copy` fan-out is
the everyday broadcast that Blender, Bitwig, TouchDesigner and ComfyUI all perform
silently.

```
copy  (coord, labels)   →  2nd edge: OK, silent broadcast
clone (frame, pcm)      →  2nd edge: OK + warn "duplicating a 4K frame ×3"
move  (budget, lease)   →  2nd edge: ERROR — declare split or route
```

Strictness lands where duplication is *unsafe*, not merely *expensive*.

## `measure` — two axes, not one

The tempting model is a single axis: *change vs state*, where a change is additive
and splittable and a state is neither. It is the right intuition and the wrong
factorization. It breaks in **both** directions:

- A cumulative counter (`requests = 1523`) is **additive** across shards, yet on
  fan-out it must be **copied**. Two dashboards each see 1523; you do not hand one
  700 and the other 823.
- A transfer of 100 coins is **additive** *and* must never be copied — duplicating
  it mints money.

Physics keeps the same two words apart: mass is extensive *and* conserved; entropy
is extensive and emphatically *not* conserved; volume likewise. Additivity and
conservation are orthogonal even in the theory the vocabulary comes from.

|  | `share: "copy" \| "clone"` | `share: "move"` |
|---|---|---|
| **extensive** (sum/concat legal) | STT transcript segments, audio chunks, log lines, shard counters | token budget, money, work items, rows of a batch |
| **intensive** (sum forbidden) | coordinates, image frames, vision label sets, config | an exclusive lease, a GPU slot, a lock token |

### The cell the single-axis story gets wrong

The **top-left** one. An STT node's transcript is a *change* — concatenating
successive segments is exactly right — but wiring it to both a translator and a
subtitle sink must give **each the whole sentence**.

It is not *indivisible-so-route-it-somewhere*. It is a **fact**, and facts are free
to copy. Round-robining a transcript between two consumers would be a bug.
**Splitting belongs to resources, not to changes.**

### Why `sum` is refused on an intensive port

Positions form a **torsor** over the vector space of displacements: `a + b` is
meaningless, `a - b` *is* a displacement (which is itself extensive), and
`mean(a, b)` is fine because its coefficients sum to 1 — an affine combination,
not a linear one.

So the gate is narrow and precise. Only `sum` and `concat` presuppose a monoid:

| merge rule | extensive | intensive |
|---|---|---|
| `sum`, `concat` | ✅ | ❌ |
| `mean`, `median` | ✅ | ✅ *(affine — a centroid is meaningful)* |
| `min`, `max`, `range` | ✅ | ✅ *(selection under an order)* |
| `mode`, `set`, `first`, `last`, `same`, `count`, `any`, `all` | ✅ | ✅ |
| a custom `(values) => string` | ✅ | ✅ *(you asserted it)* |

## `fanout` — three policies, three wires

Same topology — one port, two edges — means three different things, so rgui draws
three different wires:

| `fanout` | meaning | wire |
|---|---|---|
| `broadcast` | every downstream gets the whole value | full-width |
| `split` | divide; the parts sum back to the whole | thinned to its share, badged `1/n` (or `75%` when weighted) |
| `route` | hand an indivisible chunk to exactly one downstream | dotted |

`split` needs a **grain** — where cuts are legal:

- `"continuous"` — divisible anywhere (a number, a byte budget, a duration)
- `"atom"` — divisible only at boundaries named by `atom` (`"line"`, `"frame"`, `"row"`)

The *policy* is a property of the type; the *boundaries* are a property of the
value (a JSONL blob is line-grained, but only the value knows where its newlines
are). rgui carries the policy; the host locates the atoms. `forkValue` ships
defaults for text (line-split) and arrays (element-split), and takes an
`Atomizer<T, A>` for anything else.

An `Atomizer` is just `{ atoms, join }` — the value is a free monoid over its
atoms, which is exactly what makes a conserving split well defined:
`join(atoms(v)) === v`, and joining the parts of a split reproduces the whole.

## Usage

```ts
import {
  SIGNALS, checkSignals, forkValue, resolveSignal, groupFanout, groupWeights,
  signalConnectionGuard, port,
} from "@snomiao/rgui";

// declare on the port — `kind` alone cannot decide this, because "text" is
// extensive when it is a transcript and intensive when it is a label set
const stt = {
  outputs: [{ id: "transcript", label: "transcript", ...SIGNALS.transcript }],
};

// the group's policy: the port's default, overridden by the graph
graph.fanout = { "mic.audio": "route" };   // load-balance segments across a pool
groupFanout(graph, "mic", "audio");        // → "route"

// per-edge shares within a split
graph.edges = [
  { from: { node: "log", port: "rows" }, to: { node: "a", port: "i" }, weight: 3 },
  { from: { node: "log", port: "rows" }, to: { node: "b", port: "i" }, weight: 1 },
];
groupWeights(graph, "log", "rows");        // → [0.75, 0.25]

// validate the wiring (pure; returns diagnostics, never throws)
for (const d of checkSignals(graph))
  console.warn(`[${d.severity}] ${d.code}: ${d.message}`);

// refuse the unsafe fan-out at connect time
createRgui(canvas, { graph, isValidConnection: signalConnectionGuard(() => graph) });

// reference fan-out semantics (pure, dependency-free — use them or don't)
forkValue("こんにちは", resolveSignal(sttPort), 2);      // → both get the whole
forkValue(120, resolveSignal(budgetPort), 3);            // → [40, 40, 40]
forkValue("a\nb\nc\n", resolveSignal(jsonlPort), 2);     // → ["a\nb\n", "c\n"]
forkValue(job, resolveSignal(workPort), 3, { seq: 1 });  // → [undefined, job, undefined]
```

### Presets

`kind` cannot decide the algebra, so the combinations that keep recurring are named:

| preset | kind | measure | share | fanout |
|---|---|---|---|---|
| `transcript` | text | extensive | copy | broadcast |
| `labels` | text | intensive | copy | broadcast |
| `jsonl` | text | extensive | copy | split (`atom`/`line`) |
| `frame` | image | intensive | **clone** | broadcast |
| `pcm` | audio | extensive | **clone** | broadcast |
| `coord` | ctl | intensive | copy | broadcast |
| `budget` | ctl | extensive | **move** | split (`continuous`) |
| `work` | ctl | extensive | **move** | route |
| `lease` | ctl | intensive | **move** | route |

Note `jsonl`: freely copyable, yet its default policy is `split`. Capability and
policy really are independent.

### Defaults are the safe choice

An unmarked port is `{ measure: "intensive", share: "copy", fanout: "broadcast" }`.
Copying a fact never destroys anything, refusing to sum never fabricates anything,
and a second wire broadcasts as every node editor does — so graphs written before
this module existed keep their exact behavior.

## Diagnostics

| code | severity | when |
|---|---|---|
| `sum-on-state` | error | a port merges with `sum`/`concat` but is intensive |
| `broadcast-move` | error | a `move` signal fans out to several edges under `broadcast` |
| `cloned-fanout` | warn | a `clone` signal is broadcast to several consumers — each gets its own copy |
| `kind-mismatch` | warn | a wire joins two different `kind`s |
| `unmerged-fan-in` | warn | several edges converge with no merge rule declared |
| `grain-without-split` | warn | a `grain` on a non-`split` port, or a `split` fan-out with no grain |
| `atom-without-grain` | warn | an `atom` name without `grain: "atom"` |
| `weight-without-split` | warn | per-edge weights on a non-`split` fan-out |
| `copied-resource` | warn | a broadcasting output feeds consumers that take ownership — a double-spend |

## What rgui deliberately does not model

**Transport.** "This frame can't be copied because the consumers are on different
machines" is a *placement* question, and placement belongs to the host. rgui says
whether a value **may** be duplicated (`share`) and what that costs (`clone`); it
does not say **where** anything runs. A handle that cannot cross a machine boundary
is simply `share: "move"` — the producer already knows.

## Mapping to sflow

[sflow](https://github.com/snomiao/sflow) (WebStreams; vendored at `lib/sflow`) already
implements most of this over streams. rgui's contribution is the *conserving split*
and the declaration that says which one a port means.

| rgui | sflow |
|---|---|
| `fanout: "broadcast"` | `tees()` / `.fork()` — `ReadableStream.tee()`, duplicates to all branches |
| `fanout: "route"` | `distributeBys(fn)` — each chunk to exactly one branch; `confluences({ order: "breadth" })` for the fair/round-robin case |
| `fanout: "split"` | *no equivalent* — conservation is what rgui adds. For `grain: "atom"`, compose `lines()` with a distribute step |
| merge, extensive | `merges()` / `parallels()` — interleave, i.e. concat semantics |
| merge, intensive | `toLatests()` — i.e. `MergeRule` `"last"` |

Note that sflow's `fork()` is `tee()`: **copy** semantics. It has no notion of a
conserved quantity, which is precisely the gap this module fills.

rgui core stays dependency-free — sflow is vendored for reference, not imported.
