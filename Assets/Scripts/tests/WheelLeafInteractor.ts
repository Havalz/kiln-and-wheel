/**
 * WHEEL - shared LEAF interactor
 *
 * Only the actions used by more than one scenario live here. Everything else
 * stays inline in the scenario that needs it, so a reader can see the whole
 * flow in one file.
 */

import {DefaultLeafInteractor} from "Leaf.lspkg/Interactors/interactor/DefaultLeafInteractor";
import {findInteractableByName} from "Leaf.lspkg/Interactors/InteractableUtils";
import {sleep} from "Leaf.lspkg/Utils/common/Utils";

export class WheelLeafInteractor extends DefaultLeafInteractor {
  /**
   * Drag one profile handle. Handles are constrained to the XY profile plane
   * and ride a non-spinning rig at identity rotation, so a +X world delta is a
   * straight increase in radius at that height.
   */
  async dragHandle(index: number, delta: vec3, durationMs: number): Promise<void> {
    const name = "Handle_" + index;
    const handle = findInteractableByName(name);
    if (!handle) {
      throw new Error(name + " not found or not enabled - is the piece already fired?");
    }
    await this.drag(handle, delta, durationMs);
    // The mesher rebuilds at most once per frame on a dirty flag, so give it
    // frames to land before reading vertices back.
    await sleep(400);
  }
}
