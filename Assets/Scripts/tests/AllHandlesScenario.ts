/**
 * ALL HANDLES — every one of the eight must move the clay, on a WIDE shape.
 *
 * The narrow default pot is the easy case. The failure this guards was
 * shape-dependent: a handle's radius follows the silhouette, so editing the
 * form slid handles in and out of the pot's own tap collider and the breakage
 * moved around. So the belly is deliberately widened FIRST, putting the lower
 * handles exactly where they used to be swallowed, and only then is each of the
 * eight dragged and the real vertex buffer checked.
 */

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario";
import {expect} from "Leaf.lspkg/Utils/common/Expect";
import {findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils";
import {WheelLeafInteractor} from "./WheelLeafInteractor";
import {ProfileHandles} from "../core/ProfileHandles";
import {LatheMesher} from "../core/LatheMesher";

/** Belly radius to force before testing, in normalised profile units. */
const WIDE_R = 0.92;

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
export class AllHandlesScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1500);

    const lathe = findSceneObjectByName("WHEEL Lathe");
    expect(lathe).not.toBe(null);
    const handles = lathe.getComponent(ProfileHandles.getTypeName()) as ProfileHandles;
    const mesher = lathe.getComponent(LatheMesher.getTypeName()) as LatheMesher;
    expect(handles.isEditable()).toBe(true);

    // Force the failure condition: a fat belly across the lower half.
    const model = mesher.getModel();
    const pts = model.getPoints();
    for (let i = 1; i <= 4; i++) {
      model.setPoint(i, pts[i].y, WIDE_R);
    }
    await sleep(500);
    print("[LEAF] widened belly to r=" + WIDE_R + " before testing.");

    const visual = lathe.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    const interactor = new WheelLeafInteractor();

    const results: string[] = [];
    let failures = 0;

    for (let i = 0; i < 8; i++) {
      const before = visual.mesh.extractVerticesForAttribute("position");
      // Push inward on the wide ones and outward on the narrow ones, so every
      // handle has somewhere legal to travel and the clamps never mask a miss.
      const dir = i >= 1 && i <= 4 ? -3.5 : 3.5;
      await interactor.dragHandle(i, new vec3(dir, 0, 0), 600);
      const after = visual.mesh.extractVerticesForAttribute("position");

      const delta = maxDelta(before, after);
      const ok = after.length === before.length && delta > 0.01;
      if (!ok) failures++;
      results.push("H" + i + " " + (ok ? "PASS" : "FAIL") +
                   " delta=" + delta.toFixed(3) + "cm");
      await sleep(150);
    }

    for (let i = 0; i < results.length; i++) {
      print("[LEAF] " + results[i]);
    }
    print("[LEAF] ALL HANDLES: " + (8 - failures) + "/8 moved the mesh.");
    expect(failures).toBe(0);
  }
}
