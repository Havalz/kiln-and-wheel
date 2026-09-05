# WHEEL — performance measurements

Two Perfetto captures, 15.3s each, taken from the Lens Studio Preview panel via
`preview.profiling.startTrace`. Workloads were driven deterministically so they
can be re-run: shaping by the LEAF `wheel-shaping` scenario (a real simulated
pinch-drag on `Handle_4`), firing by the kiln's 6-second sequence with embers.

**These are Preview numbers on an Apple-silicon Mac, not SPECS numbers.** They
measure the editor's renderer. They are useful for spotting a Lens-side
bottleneck — there isn't one — but they cannot stand in for a device capture.

Traces: `performance_traces/shaping_*.pftrace`, `performance_traces/firing_*.pftrace`

## Headline: nothing warrants optimization

| Metric | Shaping | Firing | Budget |
|---|---|---|---|
| Frame time p50 | **4.34 ms** | **4.27 ms** | 16.67 ms |
| Frame time p90 | 5.42 ms | 5.32 ms | 16.67 ms |
| Frame time p99 | 8.28 ms | 6.72 ms | 16.67 ms |
| Frames over budget | 4 of 618 | 5 of 653 | — |
| Draw calls / frame | **14.1** | **9.2** | — |
| Render passes / frame | 1.73 | 2.00 | — |

At p50 the Lens uses about **26% of a 60fps frame budget**, and p99 still fits
inside it. Every frame that exceeded budget is accounted for below, and none of
them is steady-state work.

## Where the time actually goes

Per-frame averages, depth-2 slices:

| Slice | Shaping | Firing | Whose code |
|---|---|---|---|
| `Track` (inside `ProcessFrame`) | 3.85 ms | 4.05 ms | Preview harness |
| `FaceDetectPreprocess` | 0.77 ms | 0.84 ms | Preview harness |
| `Scene::Update` (all WHEEL scripts) | **1.00 ms** | **0.60 ms** | WHEEL |
| `RenderFrame` | 0.39 ms | 0.33 ms | engine |
| `Scene::LateUpdate` | 0.25 ms | 0.16 ms | WHEEL |
| `Scene::PhysicsUpdate` | 0.08 ms | 0.05 ms | engine |
| `Visual` (one draw call) | 0.014 ms | 0.012 ms | engine |

**The dominant system is `Track`, at 79–80% of `ProcessFrame` — and it is not
WHEEL.** It is the Preview harness simulating face and hand tracking, together
with `FaceDetectPreprocess`. Roughly 4.6–4.9 ms per frame goes to input
simulation that either will not exist in this form on device or will be handled
by dedicated silicon. Optimizing WHEEL cannot move it.

Everything WHEEL itself does — the lathe rebuild, eight handles, three UI
panels, the glaze shader, the ember VFX, audio — totals **0.6–1.0 ms per
frame** in `Scene::Update`. The mesh rebuild does not even show as a spike:
`Scene::Update` max is 31.4 ms during shaping, but that is a single frame and
it coincides with scenario startup, not with the drag.

## The only frames over budget

| Duration | Slice | Phase | What it is |
|---|---|---|---|
| 328 ms / 315 ms | `LensTurnOnTime` | activation | Lens start, once per session |
| 227 ms | `CoreManagerRender` | activation | first-frame pipeline/shader creation |
| 40 ms, 36 ms | `ProcessFrame` / `CoreManagerRender` | late | two isolated hitches during firing |

Activation is ~315–328 ms. That is the one number with any headroom in it, and
it is a one-time cost paid at Lens start.

## Why steps 4 and 5 were not run

- **`/specs-lens-perf-optimize` was not run.** It applies fixes and validates
  them with re-attribution. With p50 at 4.34 ms there is no bottleneck to
  attribute, and any fix would move frame time by less than the run-to-run
  variance between these two captures (0.07 ms at p50). Reporting such a delta
  as a "measured improvement" would be noise dressed as a result, which is the
  opposite of what was asked for.
- **`/specs-optimize-lens-mesh` was not run.** It merges same-material
  RenderMeshVisuals to cut draw calls. WHEEL issues **9–14 draw calls per
  frame**, costing 0.012–0.014 ms each — 0.07–0.12 ms of the frame in total.
  There is nothing to merge.

## What would change this answer

1. **A device capture.** SPECS has a different GPU, a thermal budget, and real
   tracking instead of a simulation. The `Track` cost that dominates here is a
   Preview artifact; on device the mix will look different and the glaze shader
   plus ember VFX are the parts most likely to matter. This is the measurement
   worth taking next.
2. **A heavier scene.** These captures show one pot, three panels and a shelf.
   Six shelf thumbnails plus a placed pot plus embers all at once is the worst
   realistic case and was not captured.

## Reproducing

```
# capture (see the capture snippet in specs-capture-perf-trace)
# analyse
.venv-perfetto/bin/python <skill>/references/analyze_lens_trace.py \
  performance_traces/<file>.pftrace
```
