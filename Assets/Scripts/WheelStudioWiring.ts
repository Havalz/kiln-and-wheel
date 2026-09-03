/**
 * WHEEL - WheelStudioWiring
 *
 * Glue between the UI module and the geometry core. Lives at the Scripts root
 * (not core/) because it is scene wiring, not reusable engine code.
 *
 * The direction of dependency matters: core/ knows nothing about the UI. The UI
 * emits typed events, this script subscribes and translates them into
 * LatheMesher / ProfileHandles calls. Neither side imports the other.
 */

import {LatheMesher} from "./core/LatheMesher";
import {ProfileHandles} from "./core/ProfileHandles";
import {WheelStudioUI} from "./WheelStudioUI";

const TWO_PI = Math.PI * 2;

@component
export class WheelStudioWiring extends BaseScriptComponent {
  @input
  @hint("The WHEEL Studio UI panel emitting control events.")
  ui: WheelStudioUI;

  @input
  @hint("LatheMesher driving the vessel geometry.")
  mesher: LatheMesher;

  @input
  @allowUndefined
  @hint("ProfileHandles, for UNDO. Optional - UNDO is ignored if unwired.")
  handles: ProfileHandles;

  /** Mirrors the UI so a change to one flute control preserves the other. */
  private fluteDepth = 0;
  private fluteCount = 6;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => {
      this.onStart();
    });
  }

  private onStart(): void {
    if (!this.ui || !this.mesher) {
      print("WheelStudioWiring: ui or mesher not assigned - controls inert.");
      return;
    }

    // TWIST arrives normalised 0..1; LatheMesher wants radians.
    this.ui.onTwistChanged.add((normalised: number) => {
      this.mesher.setTwist(normalised * TWO_PI);
    });

    this.ui.onFluteDepthChanged.add((depth: number) => {
      this.fluteDepth = depth;
      this.mesher.setFlute(this.fluteDepth, this.fluteCount);
    });

    this.ui.onFluteCountChanged.add((count: number) => {
      this.fluteCount = count;
      this.mesher.setFlute(this.fluteDepth, this.fluteCount);
    });

    this.ui.onUndo.add(() => {
      if (this.handles) this.handles.undo();
    });

    this.ui.onReset.add(() => {
      this.fluteDepth = 0;
      this.fluteCount = 6;
      this.mesher.setTwist(0);
      this.mesher.setFlute(0, 6);
      this.mesher.getModel().resetToDefaults();
      // Push the cleared state back so the sliders and readouts agree.
      this.ui.setTwist(0);
      this.ui.setFluteDepth(0);
      this.ui.setFluteCount(6);
    });

    this.ui.onGlaze.add(() => {
      // The glaze bench has no controls yet; this is the handoff point for the
      // next stage of the loop rather than a no-op to be silently dropped.
      print("WHEEL: GLAZE requested - glaze bench station is not built yet.");
    });

    // Seed the panel from the mesher's authored starting values.
    this.fluteDepth = this.mesher.fluteDepth;
    this.fluteCount = this.mesher.fluteCount > 0 ? this.mesher.fluteCount : 6;
    this.ui.setTwist(this.mesher.twist / TWO_PI);
    this.ui.setFluteDepth(this.fluteDepth);
    this.ui.setFluteCount(this.fluteCount);
  }
}
