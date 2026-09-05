/**
 * SHAPING — a pinch-drag on a control handle must actually move the clay.
 *
 * This reads the REAL vertex buffer back off the RenderMesh rather than
 * inferring a change from the model, because the thing that can silently break
 * is the mesh rebuild, not the maths: the model can update perfectly while the
 * lathe fails to push new vertices (that exact bug, getMesh() without
 * updateMesh(), shipped twice in this project).
 */

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario";
import {expect} from "Leaf.lspkg/Utils/common/Expect";
import {findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils";
import {WheelLeafInteractor} from "./WheelLeafInteractor";
import {ProfileHandles} from "../core/ProfileHandles";

/** Which handle to drag. 0 is the foot, 7 the rim. */
const HANDLE_INDEX = 4;

/** Widest distance from the spin axis, which is what "bounding radius" means here. */
function boundingRadius(mesh: RenderMesh): number {
  const lo = mesh.aabbMin;
  const hi = mesh.aabbMax;
  return Math.max(Math.abs(lo.x), Math.abs(hi.x), Math.abs(lo.z), Math.abs(hi.z));
}

function maxDelta(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

@component
export class ShapingScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1500);

    const lathe = findSceneObjectByName("WHEEL Lathe");
    expect(lathe).not.toBe(null);

    const handles = lathe.getComponent(ProfileHandles.getTypeName()) as ProfileHandles;
    // A fired piece is read-only by design, so say that plainly instead of
    // failing on a missing interactable further down.
    expect(handles.isEditable()).toBe(true);

    const visual = lathe.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    const before = visual.mesh.extractVerticesForAttribute("position");
    const radiusBefore = boundingRadius(visual.mesh);
    expect(before.length).toBeGreaterThan(0);

    const interactor = new WheelLeafInteractor();
    await interactor.dragHandle(HANDLE_INDEX, new vec3(4, 0, 0), 700);

    const after = visual.mesh.extractVerticesForAttribute("position");
    const radiusAfter = boundingRadius(visual.mesh);

    // Same buffer length: an edit rewrites vertices in place and must never
    // reallocate (the allocate-once contract).
    expect(after.length).toBe(before.length);
    // The vertices actually moved, by a real amount rather than float noise.
    expect(maxDelta(before, after)).toBeGreaterThan(0.01);
    // And the pot got wider where it was pulled.
    expect(radiusAfter).toBeGreaterThan(radiusBefore);

    print("[LEAF] SHAPING radius " + radiusBefore.toFixed(2) + " -> " +
          radiusAfter.toFixed(2) + " cm, max vertex delta " +
          maxDelta(before, after).toFixed(3) + " cm over " + before.length + " floats");
  }
}
