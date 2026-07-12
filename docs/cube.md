# 3D RGUI: parallel-eye stereo cube

## Display model

`/cube/` is a free-viewing stereo experiment that places a left-eye and a
right-eye projection next to each other on a 2D display. In parallel viewing,
the left-eye image stays on the left and the right-eye image stays on the
right. The viewer focuses behind the display until the two images fuse. The
implementation uses Three.js [`StereoCamera`](https://threejs.org/docs/pages/StereoCamera.html)
to generate two off-axis perspective projections from one semantic model. The
base camera's [`focus`](https://threejs.org/docs/pages/PerspectiveCamera.html)
sets the zero-parallax plane used by the stereo projection.

Finding corresponding structure between both images is a central problem in
stereopsis, and excessive binocular asymmetry makes fusion harder. Cell
positions, outlines, colors, and fusion markers therefore remain common to
both eyes. The default `MATCHED` label encoding also presents both wire digits
to both eyes. The left-eye layer gives the tens digit full contrast and retains
the ones digit at low contrast; the right-eye layer does the converse. Thus
contour correspondence is solved before contrast carries complementary
emphasis. This design follows research on stereo correspondence and binocular
asymmetry
([Vidal-Naquet and Gepshtein, 2012](https://www.frontiersin.org/journals/computational-neuroscience/articles/10.3389/fncom.2012.00047/full),
[Jung et al., 2015](https://pure.kaist.ac.kr/en/publications/critical-binocular-asymmetry-measure-for-the-perceptual-quality-a/)).

## Demo rules

- A 4x4x4 volume holds 64 unique two-digit integers sampled from 10 through 99.
- `MATCHED` is the default: both eyes see the complete number, with tens led by
  the left eye and ones led by the right. `SHARED` makes both eye images
  identical. `SPLIT` retains the original eye-exclusive experiment.
- Fuse both views, read the target number, and select its cell.
- A microscopic or mesoscopic puzzle has eight targets; the fixed-point root
  has one.
- The ordinary wheel moves a narrow focus plane in viewport depth. Because the
  depth is recomputed in camera coordinates, near and far continue to mean
  near and far after orbiting the cube. `FOCUS Z` exposes the same control.
- `Ctrl`/`Command` + wheel, keyboard `+`/`-`, or a touch pinch moves through
  the RG levels. `PARALLAX` changes eye separation and `GHOST` changes
  voxel-surface opacity.
- `H`/`J`/`K`/`L` moves the focused cell in projected screen space; `U`/`I`
  moves it farther or nearer in view depth. `Enter` tests the focused cell.
- Dragging a cell pans the camera on that cell's camera-space depth plane, so
  the grabbed cell follows the pointer with depth-correct world motion. Dragging
  empty space retains orbit control around the current camera target.
- Click `peek` to lock both digits into both eye images, or hold it for a
  temporary accessible check.
- `PARALLEL / CROSS` changes the free-viewing method. Cross-eye mode swaps the
  complete eye images: the physical left panel receives the right-eye image,
  while the physical right panel receives the left-eye image.
- The top bar, RG lab, controls, result status, and help panel are rendered once
  per eye panel. Either physical control copy drives the same state. The two
  help copies share scroll position and animate with perspective `translateZ`
  plus eye-opposed disparity; parallel/cross mode reverses that disparity.
  Width and height remain intact rather than collapsing toward zero.

## Binocular label encodings

The original design sent the tens digit only to one eye and the ones digit only
to the other. Spatially separating the digits avoided direct contour overlap,
but each corresponding label region still contained substantially different
content. That can produce suppression or unstable alternation instead of a
single readable number.

The replacement is based on a stronger invariant: **every important contour
has a corresponding contour in the other eye**. Matching features can stabilize
fusion even when another component differs
([Blake and Boothroyd, 1985](https://doi.org/10.3758/BF03202845)). Contrast can
then carry a softer eye-specific emphasis; contrast is known to affect which
contours dominate during rivalry
([Whittle, 1965](https://doi.org/10.1080/17470216508416435)).

| Encoding | Left-eye label | Right-eye label | Purpose |
| --- | --- | --- | --- |
| `MATCHED` | Both digits; tens at 100%, ones at 42% | Both digits; tens at 42%, ones at 100% | Default compromise: stable correspondence plus complementary emphasis |
| `SHARED` | Complete high-contrast label | Identical complete label | Most comfortable and accessible; stereo conveys space rather than hidden text |
| `SPLIT` | Tens only | Ones only | Legacy dichoptic experiment for direct comparison |

A random-dot stereogram could encode the digits entirely in disparity, making
them genuinely cyclopean rather than monocular. It is not a good default for a
dense, moving 64-label cube: complex random-dot stereograms can take substantial
practice and viewing time to resolve
([Frisby and Clatworthy, 1975](https://doi.org/10.1068/p040173)). It remains a
candidate for a separate single-label calibration scene.

## Merge model

A merge rule has three independent parts. Conflating them is the main source
of ambiguous RG behavior.

1. **Support/topology** chooses the children represented by each parent and a
   weight `w(parent, child)`. Hard supports have one owner per child;
   overlapping supports do not.
2. **Value reduction** maps the weighted child observables to the parent
   observable. The lab offers weighted mean, weighted median, and sum.
3. **Residual policy** decides whether discarded detail can be recovered. This
   demo always retains the immutable 64-cell source and derives every level
   from it, so zooming back in restores exact labels rather than re-expanding a
   lossy parent.

The resulting flow is `4x4x4 -> 2x2x2 -> 1x1x1`. The following support methods
are selectable independently from the reducer:

| Method | Parent support | Ownership | Intended use |
| --- | --- | --- | --- |
| `BLOCK 2x2x2` | Eight aligned face/edge/corner-adjacent voxels | Hard, disjoint | Default for identity-bearing UI cells and containers |
| `GAUSSIAN 3^3` | A separable Gaussian kernel over 27 nearby samples at the mesoscopic level | Soft, overlapping | Anti-aliased LOD for continuous scalar fields |
| `GRAPH 6-N` | Eight face-connected voxels selected from deterministic Hamiltonian-path candidates using value variation and compactness | Hard, disjoint | Irregular semantic regions whose adjacency matters more than axis alignment |

The reducer is semantic, not geometric. Mean is appropriate for an intensive
quantity; sum is appropriate for an extensive quantity; median is robust to an
outlier. Since the puzzle must display unique two-digit targets, sum is folded
into `10..99` and display collisions advance deterministically. The unmodified
`rawValue`, mean, variance, mass, and source membership remain in the model;
the two-digit value is only the puzzle's display encoding.

## Why these options

Kadanoff's cell construction motivates a hard local block as the conservative
default for coarse-graining a lattice
([Kadanoff, 1966](https://doi.org/10.1103/PhysicsPhysiqueFizika.2.263)). A
Gaussian convolution answers a different question: it creates a scale-space
sample of a field, where overlapping influence is desirable rather than an
ownership bug ([Lindeberg, 1990](https://doi.org/10.1109/34.49051)). For an
irregular UI graph, multilevel graph coarsening motivates contracting connected
regions while controlling balance and locality
([Karypis and Kumar, 1998](https://doi.org/10.1137/S1064827595287997)). These
are alternatives because the domain semantics differ; there is no universal
kernel that is correct for objects, fields, and graphs at once.

For a production reversible RG representation, retaining only the parent is
not enough. A multiresolution transform would store a coarse component plus
detail coefficients, following the residual structure of wavelet analysis
([Mallat, 1989](https://doi.org/10.1109/34.192463)). The experiment currently
keeps the source lattice instead, which is simpler and gives exact round trips.

The root is a fixed point for this finite dataset: further zoom-out cannot
create a second distinct parent without external data. RGUI can keep the
navigational zoom operation unbounded while the representation remains at that
readable fixed point. Truly unbounded inward detail requires procedural or
streamed child data; inventing children from a two-digit root would not be an
inverse RG operation.

## Design invariants

- Face-sharing `6-N` is the default graph adjacency. Edge or corner contact is
  added only when the domain says it is a coupling.
- Directional x/y/z couplings should remain directional after contraction;
  internal edges disappear and external edges aggregate by parent pair.
- Merge thresholds should eventually use projected footprint in both eye
  images with hysteresis, rather than camera distance alone.
- Focus, opacity, occlusion, stereo separation, and eye mode are view state.
  They never mutate the semantic representation shared by both eyes.
- A fourth axis remains explicit time or another domain dimension until the
  application defines its adjacency and reducer; it is not silently folded
  into z.

## Spatial finger input

The cube listens for the versioned otoji spatial cursor contract on
`BroadcastChannel("otoji-spatial")`. Stable tracking engages a relative 3D
cursor: fingertip x/y moves across the view and metric z moves the focus plane.
The same world cursor is projected through both stereo eye cameras.

A hand-relative 2D pinch gates actions while calibrated joints provide motion.
A short pinch selects the focused cell; a sustained or moving pinch pans at the
current focus depth. Mouse, wheel, keyboard, and finger input remain available
together. Low-confidence or lost tracking cancels the gesture without selecting.
Right-button dragging always orbits the cube and suppresses the browser context
menu, including when the drag begins over a cell.
When no pointer or finger grab is active, the view rotates slowly around its
center. Rotation pauses while the help panel is open.

BroadcastChannel is same-origin only. Cross-origin otoji/rgui deployments need
a `postMessage` or WebRTC relay that forwards the same v1 envelope.
