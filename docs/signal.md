# The rgui signal algebra

`MergeRule` answers *"how do a node's field values combine when nodes renormalize
into one block?"*. This answers the same question one level down — for the data on
the **ports** — and adds the question renormalization never had to ask: what
happens on the way **out**.

rgui does not execute graphs. Its job here is to let a port **declare** its
algebra, **validate** the wiring against it, and **render** the difference. The
host (otoji, sflow, your own scheduler) executes.

## Two axes, not one

The tempting model is a single axis: *change vs state*, where a change is additive
and splittable and a state is neither. It is the right intuition and the wrong
factorization. Two independent properties hide inside it:

| axis | question | field |
|---|---|---|
| **measure** | is `+` meaningful across parallel sources? | `measure: "extensive" \| "intensive"` |
| **fanout** | is duplicating this value free, or does it violate a conservation law? | `fanout: "copy" \| "split" \| "route"` |

They come apart in *both* directions, which is what forces them apart:

- A cumulative counter (`requests = 1523`) is **additive** across shards, yet on
  fan-out it must be **copied**. Two dashboards each see 1523; you do not hand one
  700 and the other 823.
- A transfer of 100 coins is **additive** *and* must never be copied — duplicating
  it mints money.

Physics keeps the same two words apart: mass is extensive *and* conserved; entropy
is extensive and emphatically *not* conserved; volume likewise. Additivity and
conservation are orthogonal even in the theory the vocabulary comes from.

## The 2×2

|  | `fanout: "copy"` | `fanout: "split"` / `"route"` |
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

## Why `sum` is refused on an intensive port

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

## Fan-out: three modes, three wires

Same topology — one port, two edges — means three different things, so rgui draws
three different wires:

| `fanout` | meaning | wire |
|---|---|---|
| `copy` | broadcast a fact; every downstream gets the whole value | full-width |
| `split` | divide a resource; the parts sum back to the whole | thinned, badged `1/n` |
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
import { SIGNALS, checkSignals, forkValue, resolveSignal, port } from "@snomiao/rgui";

// declare on the port — `kind` alone cannot decide this, because "text" is
// extensive when it is a transcript and intensive when it is a label set
const stt = {
  outputs: [{ id: "transcript", label: "transcript", ...SIGNALS.transcript }],
};

// validate the wiring (pure; returns diagnostics, never throws)
for (const d of checkSignals(graph))
  console.warn(`[${d.severity}] ${d.code}: ${d.message}`);

// reference fan-out semantics (pure, dependency-free — use them or don't)
const spec = resolveSignal(myPort);
forkValue("こんにちは", resolveSignal(sttPort), 2);      // → both get the whole
forkValue(120, resolveSignal(budgetPort), 3);            // → [40, 40, 40]
forkValue("a\nb\nc\n", resolveSignal(jsonlPort), 2);     // → ["a\nb\n", "c\n"]
forkValue(job, resolveSignal(workPort), 3, { seq: 1 });  // → [undefined, job, undefined]
```

### Presets

`kind` cannot decide the algebra, so the combinations that keep recurring are named:

| preset | kind | measure | fanout | what it is |
|---|---|---|---|---|
| `transcript` | text | extensive | copy | STT segments — concat over time, broadcast to all |
| `labels` | text | intensive | copy | `"person, chair"` — a snapshot of one frame |
| `jsonl` | text | extensive | split (`atom`/`line`) | records shared across workers, never cut mid-line |
| `frame` | image | intensive | copy | one image |
| `pcm` | audio | extensive | copy | audio chunks — concat in time, copied to recorder + STT |
| `coord` | ctl | intensive | copy | a position/setting |
| `budget` | ctl | extensive | split (`continuous`) | a divisible allowance |
| `work` | ctl | extensive | route | work items — additive in count, individually indivisible |
| `lease` | ctl | intensive | route | an exclusive lock/slot |

### Defaults are the safe choice

An unmarked port is `{ measure: "intensive", fanout: "copy" }`. Copying a fact
never destroys anything and refusing to sum never fabricates anything, so graphs
written before this module existed keep their exact behavior.

## Diagnostics

| code | severity | when |
|---|---|---|
| `sum-on-state` | error | a port merges with `sum`/`concat` but is intensive |
| `kind-mismatch` | warn | a wire joins two different `kind`s |
| `unmerged-fan-in` | warn | several edges converge with no merge rule declared |
| `grain-without-split` | warn | a `grain` on a non-`split` port, or a `split` fan-out with no grain |
| `atom-without-grain` | warn | an `atom` name without `grain: "atom"` |
| `copied-resource` | warn | a broadcasting output feeds a consumer that takes ownership — a double-spend |

## Mapping to sflow

[sflow](https://github.com/snomiao/sflow) (WebStreams; vendored at `lib/sflow`) already
implements most of this over streams. rgui's contribution is the *conserving split*
and the declaration that says which one a port means.

| rgui | sflow |
|---|---|
| `fanout: "copy"` | `tees()` / `.fork()` — `ReadableStream.tee()`, duplicates to all branches |
| `fanout: "route"` | `distributeBys(fn)` — each chunk to exactly one branch; `confluences({ order: "breadth" })` for the fair/round-robin case |
| `fanout: "split"` | *no equivalent* — conservation is what rgui adds. For `grain: "atom"`, compose `lines()` with a distribute step |
| merge, extensive | `merges()` / `parallels()` — interleave, i.e. concat semantics |
| merge, intensive | `toLatests()` — i.e. `MergeRule` `"last"` |

Note that sflow's `fork()` is `tee()`: **copy** semantics. It has no notion of a
conserved quantity, which is precisely the gap this module fills.

rgui core stays dependency-free — sflow is vendored for reference, not imported.
