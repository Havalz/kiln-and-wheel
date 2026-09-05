@AGENTS.md

# WHEEL

## Project

WHEEL is a spatial ceramics studio for SPECS.

**Naming — read this first.** "WHEEL" means a **potter's wheel**. It is never a vehicle wheel, tyre, rim, hub, or spoke. An agent that infers the domain from the directory name alone builds the wrong object; that has already happened here once.

The loop: shape a silhouette by pinch → lathe it live with MeshBuilder → glaze it → fire it → place it in the room.

## Stack

- **Lens Studio MCP** — configured in `.mcp.json`. It carries a bearer token: never paste its contents into a file, commit, or message.
- **ls-clad plugin** — skills that matter here: `lens-studio-router` (entry point), `mesh-builder-scripting` (runtime geometry), `specs-interaction-recipes` (pinch/SIK), `specs-build-ui`, `verify-preview`, `lens-api`.
- **MeshBuilder** — every vessel is generated at runtime; there are no authored meshes.
- **SIK** and **UI Kit** — installed; SIK is in the scene.
- **RSG** — installed, deliberately unwired.
- **PersistentStorage** — intended store for saved pots. Not used yet.

## Conventions

`Assets/Scripts/core/` holds reusable engine pieces (`ProfileModel.ts`, `LatheMesher.ts`); demo and scene-glue scripts (`Spin.ts`) stay at the `Assets/Scripts/` root. Filenames are PascalCase and match their primary export, one per file.

Components are `@component export class X extends BaseScriptComponent`. Pure logic lives in plain exported classes importing nothing from the Lens API or any package, so it stays runnable in plain Node for verification. Shared constants are `export const` (`PROFILE_SAMPLES`, `CONTROL_POINTS`), never re-typed as literals at call sites.

## Fixed parameters

Do not re-derive or tune these:

- **8** control points, Catmull-Rom resampled to **48** profile samples.
- **48** radial segments at rest, **16** while dragging.
- **Allocate-once buffers.** Vertex and index buffers are appended once per LOD; an edit rewrites vertex data and calls `updateMesh()`. Never construct a MeshBuilder or rebuild an index buffer per edit.
- Any future AI call: **20-second timeout with a local fallback**.

## Constraints

Pinch is the only interaction. No multiplayer, no Sync Kit, no database, no live backend this round. RSG stays unwired until explicitly requested.

**Waveguide display:** black renders as transparent, so dark values vanish on the glasses. Use bright, high-saturation palettes only.

## Known limitations

Simulated pinches DO reach panel buttons inside a FlexLayout — FIRE, GLAZE →, RESET and UNDO are all confirmed, as are manually-positioned interactables outside a layout (shelf slots, the pot's grab capsule); the earlier "UNDO and GLAZE → don't respond" was never a targeting problem but two silent no-ops (GLAZE → was a `print()` stub, UNDO returned false on an empty stack without saying so), so when a control looks dead, check whether its handler produces any visible effect before suspecting the hit target.

**Dragging a control handle is now the project's strongest-verified interaction.** The LEAF scenario `wheel-shaping` drives a simulated pinch-drag on `Handle_4` and reads the result straight back off the mesh with `RenderMesh.extractVerticesForAttribute("position")` — 7206 floats, the 2402-vertex HIGH LOD — asserting the vertices moved (max delta 4.055 cm) and the bounding radius grew (6.16 → 7.08 cm). That is stronger evidence than any button test here, which only observe a handler's side effect. **Use LEAF, not `PreviewInteractTool`, for handle drags:** the MCP tool refuses with `Blocked by "WHEEL Lathe" between camera and target` because the handles sit at ~4–5cm radius, inside the pot's ~7cm surface, and its occlusion check runs camera-to-target; LEAF's interactor drives SIK directly and is unaffected. That is a tool limitation, not a Lens one.

## Do not

- Never run parallel agents that mutate the open Lens Studio scene at once — it is shared mutable state with no locking.
- Never add a network dependency unasked.
- Never delete files without asking first.
- Do not restate AGENTS.md (coordinate system, units, lifecycle, the two APIs, the MCP rule); it is imported above. Its content sits in a Lens Studio managed block that is overwritten on regeneration — durable rules belong here.
