# CLAD prompt log

How WHEEL was actually built: the prompts, the agents and skills that ran, and —
at greater length than the successes — what broke and how it was corrected.

**On sourcing.** Entries are reconstructed from the git history (29 commits) and
the session record. Where a claim is verifiable in a commit, the hash is cited.
Where it is not, the entry is marked **[approximate]** and says what is and is
not certain. Nothing here is invented to fill a gap.

**On phase numbering.** Numbered phases run P0–P11 and are visible in commit
subjects. The work after P11 — LEAF, performance, and three polish rounds — was
never numbered at the time, so it is recorded under its real commit subjects
rather than given retrospective P12–P14 labels.

---

## P0–P1 · Lathe core

**Prompt** — Build the runtime lathe: 8 control points, Catmull-Rom to 48
samples, revolved with MeshBuilder, allocate-once buffers, dual LOD.

**Skills** — `lens-studio-router`, `mesh-builder-scripting`, `scene-construction`.

**Built** — `ProfileModel`, `LatheMesher`, `LatheLod`. Vertex and index buffers
appended once per LOD; edits rewrite in place and call `updateMesh()`.
`2e003a1`.

### What failed: an agent built a vehicle wheel

A parallel agent inferred the domain from the folder name `WHEEL` and generated a
**vehicle wheel** — tyre, rim, spokes — instead of a potter's wheel. Removed in
`6db85c9` ("Remove stray vehicle-wheel generator and unused vertex-color
package").

The correction was not just deleting the file. `CLAUDE.md` gained a naming
section as the *first* thing any agent reads:

> "WHEEL" means a **potter's wheel**. It is never a vehicle wheel, tyre, rim,
> hub, or spoke. An agent that infers the domain from the directory name alone
> builds the wrong object; that has already happened here once.

That is the pattern this log is mostly about: a failure is only closed when the
next agent cannot repeat it.

---

## P2 · Handle rig

**Prompt** — Decouple the control handles from the wheel's spin.

**Skills** — `specs-interaction-recipes`, `lens-api`.

**Built** — The handle rig became a scene-root object at identity rotation,
synced to the lathe's position every frame, so handles never inherit the spin.
`40e0f65`.

### What failed: the interaction package was deleted **[partly approximate]**

`AiPreviewAgentInteract.lspkg` was removed during cleanup, which broke
`AgentInteractScript` and with it every simulated-gesture tool. Recovery was to
reinstall the package — leaving two copies, `AiPreviewAgentInteract.lspkg` and
`AiPreviewAgentInteract 2.lspkg`, both of which shipped until submission prep.

*Not certain from the record:* the exact prompt that triggered the deletion and
the precise recovery steps.

*Certain, and verified at submission prep:* the two copies were **byte-identical
archives** (same md5, 33294 bytes) that differed only in their `.meta`
registration — and the naming was the reverse of what anyone would assume:

| | ImportedAssetIds | Owns the scene's `AgentInteractScript` asset? |
|---|---|---|
| `AiPreviewAgentInteract.lspkg` | **empty** | no |
| `AiPreviewAgentInteract 2.lspkg` | **20 assets** | **yes** (`29091811-…`) |

The scene's `AgentInteractScript` points at ScriptAsset `29091811-…`, declared
only in the **" 2"** copy's meta. The plain-named copy was the inert shell. So
the intuitive cleanup — delete the one with the ugly " 2" suffix — is precisely
the deletion that breaks the agent bridge, which is most likely what happened
the first time.

The duplicate was finally removed by deleting the **plain** copy, after tracing
the asset ownership, with both copies backed up first and the bridge re-tested
immediately afterwards (a simulated pinch still reached the Lens and started a
firing; zero unresolved-asset errors).

**Rule that came out of it:** never delete files without asking first — now
in `CLAUDE.md` under "Do not".

---

## P3 · Studio UI

**Prompt** — Three stations: the wheel, the glaze bench, the kiln. Waveguide-safe
palette throughout.

**Skills** — `specs-build-ui`, `materials`.

**Built** — UIKit flex panels, wheel controls, bright saturated palette on the
principle that black renders transparent on the waveguide. `fb4773b`.

---

## P4 · Glaze shader

**Prompt** — A glaze shader with a gravity gradient, crackle, and six presets.

**Skills** — `shader-graph`, `materials`.

**Built** — Two-point vertical gradient, rim tint, crackle network, drips that
pool by gravity via the normal's vertical component, and a hard 0.30 floor on
every colour channel so no glaze can vanish on the glasses. `b8ab9d8`.

---

## P5 · Voice → Gemini glaze

**Prompt** — Describe a glaze out loud; Gemini returns real material parameters.
20-second timeout with a local fallback.

**Skills** — `specs-asr`, `specs-ai-remote-service`, RSG.

**Built** — ASR capture, Gemini via Remote Service Gateway, schema-validated
reply, six offline presets on any failure, plus `Tools/refresh-rsg-tokens.ts`
and a project skill to drive it. `1aaf362`.

### What failed: live credentials committed in plaintext

This commit is where the leak started. `RemoteServiceGatewayCredentials` stores
`snapToken` / `openAIToken` / `googleToken` as plaintext inside
`Assets/Scene.scene`, which is tracked — so live tokens rode into the repo and
sat in **seven consecutive commits** from P5 to HEAD. They were not stale: a
refresh returned the same values and Gemini answered with them minutes before
the fix.

Three-part correction, all in `069e2c4`:

1. **Blanked** to `[INSERT … TOKEN]` — through the Editor API, not by editing
   the file, because Lens Studio holds the scene in memory and overwrites a disk
   edit on its next save.
2. **A pre-commit hook** (`Tools/pre-commit-token-guard.sh`) that greps staged
   diffs for UUID-shaped token values and blocks the commit.
3. **History scrubbed** with `git filter-repo` across all seven commits, which
   was safe because no remote existed yet.

*Verified now:* `git log --all -p -- Assets/Scene.scene` contains **zero**
UUID-shaped token additions. The scrub held.

The hook has since earned its keep — it was still armed at submission prep,
when a `/refresh-rsg-tokens` run put live tokens back into the working tree.

---

## P6 · Kiln firing

**Prompt** — A six-second firing, seeded so the same pot always fires the same
way. Embers, crystal blooms, heat shimmer.

**Skills** — `vfx-graph`, `shader-graph`, `build-sfx`.

**Built** — `FiringSeed.ts`: FNV-1a over the serialised profile driving a
mulberry32 PRNG, so hue shift, crackle, drip and bloom placement are
reproducible. 17/17 Node assertions; 400 firings stayed inside their envelopes
and never breached the 0.30 waveguide floor.

### What failed (1): a commit message the diff contradicted

The first P6 commit `6c762ae` was subjected **"seeded variation, ember VFX,
crystal blooms, piece locking"** — but the ember VFX and the crystal blooms did
not exist in that diff. Rather than let the summary line stand, the commit body
opens with:

> `SCOPE WARNING: two items named in the subject are NOT working. Recorded here
> so the next reader is not misled by the summary line.`

and the follow-up commit `946506c` says so explicitly:

> `Supersedes the earlier P6 commit, whose subject claimed ember VFX and blooms
> that did not exist at the time.`

The final subject records the deferral in the summary itself: *"crystal blooms
and heat shimmer deferred; mechanic fully proven"*. A commit message is a claim
about the diff, and a claim the diff does not support does not get recorded.

### What failed (2): crystal blooms, deferred not solved

Crystal blooms were investigated across several sessions **[approximate — the
git record shows the deferral and the two-commit correction; "three sessions" is
from the session record, not from git]** and narrowed to a suspected Shader
Graph transpiler issue: the bloom term compiled without error but produced no
visible output, and isolating it in the graph did not reproduce the failure.

It was **deliberately parked**, not quietly dropped — named in the commit
subject, and named again in the README's Known limitations. Deferring a feature
loudly is cheaper than shipping a broken one quietly.

---

## P7 · Audio

**Prompt** — A wheel hum that responds to the piece, and a ping test: tap a pot
and hear it ring.

**Skills** — `build-sfx`, `specs-audio`.

**Built** — Dual-loop crossfaded hum, and a ping that picks one of three
pre-rendered bells by the vessel's computed volume — pitch from physics, not
from a slider. `e694b75`.

---

## P8 · Placement, shelf, naming

**Prompt** — Place a fired pot in the room; keep a shelf of finished work; have
Gemini name and critique each piece.

**Skills** — `specs-world-query`, `specs-depth`, PersistentStorage.

**Built** — `63de7d3`, then `ef28479` for the shelf panel with live miniature
lathes, then `1124cf8` for pinch-to-drop.

### What failed: a seed overflow that produced "Rough undefined, undefined"

`ShelfStore.localName()` used **signed** right shifts to derive words from the
seed. FNV-1a fills the full uint32 range, so at seed 3028517782 the shift went
negative and indexed off the end of the word arrays. Fixed with unsigned
shifts (`>>>`) and seven regression assertions. Same class of bug was
pre-emptively guarded in the decoder page, which carries the note *"UNSIGNED
shifts: the seed fills the full uint32 range and a signed shift yields a
negative index."*

Also fixed here: `ShelfManager.glazeMaterial` pointed at an orphaned material, so
a reload would repaint a material nothing rendered with.

---

## P9 · Voice-thrown silhouette

**Prompt** — Shape a pot with your voice: RMS envelope → 8 control-point radii,
4-second take, editor fallback path.

**Skills** — `specs-audio`, `mesh-builder-scripting`.

**Built** — `VoiceThrow.ts` + `VoiceEnvelope.ts`, 44 assertions. `8761192`.

### What failed (1): sipping the microphone

Reading one audio frame per update gave **3 frames across a 4-second take** — a
pot with three steps in it rather than a curve. The provider buffers at its own
cadence, not the render cadence. Fixed by draining in a bounded loop until the
provider reports nothing: 3 frames became 8.

### What failed (2): a fixed smoothing window flattened the pot

A 5-sample smoothing window applied to a short envelope flattened the silhouette
into a cylinder. Made the window length-relative (`smoothWindowFor(n)`).

---

## P10 · Export bridge

**Prompt** — 35-byte payload, base64url, self-contained QR encoder, mandatory
text-URL fallback.

**Skills** — `script-author` (parallel authoring), `materials`.

**Built** — `ProfileCodec.ts`, `QRCodeGen.ts`, `QRTexture.ts`. Verified against
Apple CoreImage as an independent decoder. `1da3280`.

### What failed: `getMesh()` without `updateMesh()`

The QR quad and the voice level bar both reported `mesh: ""` and drew nothing.
A `MeshBuilder` mesh is not committed until `updateMesh()` is called; fetching
the handle first hands the visual an uncommitted mesh. Fixed in both places and
called out in the commit subject so the pattern was recorded, not just patched.

This bug **recurred twice more** later — in `KilnHeatRings.buildQuad` and in
`VoiceThrow.buildQuad` — and was caught each time by the same symptom.

### Also failed: `baseTex` is a silent no-op

`UnlitMaterialPreset` gates `baseTex` behind an `ENABLE_BASE_TEX` define.
Assigning a texture without it fails silently; enabling it on a material with no
texture bound renders **magenta**. Resolved with a separate `QRPlateMat` with
the define off.

---

## P11 · Companion decoder page

**Prompt** — A single static page, no build step, no server, no database, no
analytics. A stateless decoder.

**Built** — `docs/index.html` (299 lines) + `docs/sw.js`. Inverse codec verified
by a 300-piece round-trip with zero delta, STL/OBJ export, offline via service
worker. `717dad9`.

The page re-implements the Lens's Catmull-Rom resampling and its twist and flute
formulas rather than baking a mesh, so the browser reproduces the same 48 samples
the Lens lathed.

---

## LEAF · Automated scenarios

**Prompt** — Lock the experience in with automated tests.

**Skills** — `specs-leaf-install-packages`, `specs-leaf-write-scenarios`,
`specs-leaf-run-in-preview`, `live-lens-tester`.

**Built** — Four re-runnable scenarios: shaping, glaze fallback, firing,
persistence. `3c145ea`. Two more were added during final hardening
(`wheel-ping-test`, `wheel-all-handles`), bringing the suite to six.

### What this corrected: a claim about the tool, not the Lens

`wheel-shaping` drives a simulated pinch-drag on a handle and reads the result
straight off the mesh — 7206 floats, max delta 4.055 cm, bounding radius
6.16 → 7.08 cm. That turned handle dragging from the project's *least* verified
interaction into its strongest, and corrected an earlier `CLAUDE.md` note
claiming handle drags could not be tested. `302409a`.

The real finding: `PreviewInteractTool` refuses handle drags with
`Blocked by "WHEEL Lathe" between camera and target` — a **tool-side occlusion
check**, not a Lens limitation. LEAF drives SIK directly and is unaffected.

---

## Performance

**Prompt** — Run the full performance loop. "I want the measured numbers, not
estimates."

**Skills** — `specs-capture-perf-trace`, `perfetto-trace-analysis`.

**Result** — p50 **4.34 ms** against a 16.67 ms budget; p99 8.28 ms, still
inside. WHEEL's own scripts account for 1.00 ms of `Scene::Update`; most of the
rest is the Preview harness's face tracking, which does not ship.

**The outcome was to change nothing.** `ab203da` — *"measure the Preview profile,
find nothing worth optimizing"*. Optimising a 26%-of-budget frame would have been
motion without progress.

---

## Polish rounds

Three rounds, each from a specific complaint rather than a general request.

**`5fe6e80` — waveguide audit, first-run guidance, error surfaces.** Every colour
checked against Rec.709 luminance; `GLAZE_FLOOR` 0.306 → 0.357 and Tenmoku
0.350 → 0.389. Error strings rewritten as one short human sentence — "No surface
found — set it down in front of you." — never a raw error, never a silent hang.

*Failed and fixed:* `putBool` did not survive a reload for the first-run flag;
switched to `putString`. And the hint stuck on "Glaze it" because glazing is
optional, so the cycle could never complete — made the stage counter monotonic.

**`0c45410` / `10dbe2a` — type scale and layout rhythm.** Text was overflowing
the plate; the fix was a real type scale, not a nudge.

*Failed and fixed:* an early "clipped buttons" diagnosis was **wrong** —
`--headless=new` ignored `--window-size`, so the page rendered at 500px while
being screenshotted at 390. The clipping was a crop artefact. Re-measured
through a 320px iframe: `body=320, scrollWidth=320`. No layout bug existed.

---

## World Query · three rounds, ending in a conclusive negative

The longest-running investigation, and the one that produced the most durable
correction.

### Round 1 — a stale claim carried across two different modules

An early note asserted *"Preview streams no depth"* and, on that basis, the
placement ray was cast **straight down** from the pot — three metres outside the
camera frustum, where by definition no depth exists.

The claim was true of `DepthModule` and had been carried over to
`WorldQueryModule`, which is a different API. **The user corrected this with the
official docs:** Interactive Preview is a supported configuration for World
Query, and `EXPERIMENTAL_API` is required only for semantic `classification`,
which this project does not use.

Corrected in three places at once — the code, the fallback log string, and
`CLAUDE.md` — under a heading that names the confusion so it cannot recur:
**"World Query is not Depth Module."** `2273d2a`.

### Round 2 — fix the ray, keep the metaphor

Instruction was explicit: keep the drop metaphor, cast inside the viewed region,
retry across frames, **and stop after two diagnostic attempts.** The ray was
rebuilt as a forward-and-down sweep across 12 probes with retries. Result: still
no hit. The budget was honoured and the fallback kept.

### Round 3 — the positive control

The question left was whether the scene had anything to hit at all. Two
independent probes:

- **14 raw `WorldQueryModule` casts**, warm and cold sessions, swept through the
  viewed region — 0 hits.
- **A 12-ray `Physics.Probe` grid** — hits **only** the Lens's own
  `InteractionPlaneColliderRoot`.

That last one is the point. It is a **positive control**: the probe demonstrably
works, which converts "we found nothing" from a possible bug in our code into
evidence about the scene. The Evening Room preview scene carries neither
queryable depth nor furniture colliders.

Recorded as a conclusive negative with its scope stated: this says nothing about
device behaviour, which remains untested.

---

## Final hardening

Three bugs found by using the thing rather than by reading it.

**The ping that moved the pot.** Tapping a fired pot rang the bell *and* flung it
across the room into the wheel panel. Cause: `PotPlacement` bound `place()` to
`onTriggerEnd`, which fires on **any** release — a tap and a drag end
identically. Fixed with a shared gesture rule (`core/TapGesture.ts`): a tap is
short **and** still (≤0.35 s, ≤3 cm); anything else places. Both conditions must
hold, so neither a flick nor a lingering touch can be misread. A panel-clearance
guard now pushes any placement clear of all four plates.

**The lower handles that would not respond — two wrong diagnoses first.** The
bottom three handles ignored every pinch, and the third worked *intermittently*,
which ruled out a static cause. Two fix attempts missed. The third started with
**instrumentation instead of a guess**: dump all eight handles' state, then ray
cast from the camera to each.

Every handle was byte-identical — `objEnabled=true interEnabled=true mode=3`.
The rays were not:

```
H0 ray hits: 1)WHEEL Lathe@99.5  2)Handle_0@105.3
H1 ray hits: 1)WHEEL Lathe@99.3  2)Handle_1@105.1
H2..H7     : 1)Handle_N
```

The occluder was `WheelAudio`'s ping collider — a fixed 18×24×18 box centred on
the lathe **origin, which is the foot**, so it covered the pot's lower half and
was created wet or fired. Handles deep inside it lost the ray; handles whose
radius carried them toward its edge won, and editing the shape slid them across
that boundary. That is exactly the reported intermittency. Fixed by gating the
tap target on `isFired()` and sizing its box to the actual vessel. Verified
8/8 on a deliberately widened silhouette.

**A near-field slab nobody could see.** Earlier in the same investigation, UIKit's
`BackPlate` was found to ship a **17 cm invisible near-field interaction slab**
that reached 16 cm above the plate's visible top edge and captured any handle
inside it. Pulled in to 5 cm. The first attempt at this fix **silently did
nothing** — the component is created during UIKit's own start, after the panel is
assembled, so reaching for it at build time found nothing and logged
`no InteractionPlane on Station_Wheel`. Made it retry across frames.

---

---

## A note on the debug inputs left in the code

Several components ship with editor-only hold switches — `holdHeatNow` /
`holdHeat` on `KilnStation`, `holdPreviewNow` on `VoiceThrow`, `holdPulseNow` /
`holdBeat` on `GlazeBenchVoice`, and `runHandleDiagnosticsNow` on
`ProfileHandles`. They default off, auto-clear, and cost nothing when idle.

They are kept deliberately, because three of the bugs in this log were found
with them and could not have been found without them:

- **`runHandleDiagnosticsNow`** dumped all eight handles' state and ray cast from
  the camera to each. It proved every handle was byte-identical and that the
  difference was in what the ray met first — which is what identified the ping
  collider as the occluder after two wrong diagnoses.
- **`holdPreviewNow` / `holdPulseNow`** pin a four-second take and a three-beat
  animation so they can be inspected without racing them.
- **`holdHeatNow`** pins the firing curve. It was added at submission prep after
  two screenshot attempts landed *after* the reveal — the editor's panel grab is
  slower than the six-second sequence. With the clock stopped, the heat rings
  photographed first try, which also confirmed the effect had been working all
  along and had simply never been capturable.

An effect that cannot be observed cannot be verified, and several rounds were
lost to tuning things blind before these existed. They are part of the method,
not leftovers.

## What the loop actually looked like

The pattern that recurs across every phase above:

1. **A claim gets made** — in a commit subject, a `CLAUDE.md` note, or a
   diagnosis.
2. **Evidence contradicts it** — a capture, a log line, a ray cast, or the user.
3. **The claim is corrected at its source**, not patched around: the commit is
   superseded, the note is rewritten under a heading that names the confusion,
   the instrumentation is kept.

The three most useful things in this project are not features. They are the
naming paragraph at the top of `CLAUDE.md`, the pre-commit hook, and the LEAF
suite — each one a failure that was closed so it could not happen twice.
