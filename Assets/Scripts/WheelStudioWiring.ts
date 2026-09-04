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
      if (!this.handles) {
        this.ui.setWheelStatus("Undo unavailable");
        return;
      }
      // undo() returns false for two different reasons and says which is which
      // only through state, so ask before calling: a held handle is a "not
      // now", an empty stack is a "nothing to undo". Reporting both as failure
      // is what made this button look broken.
      if (this.handles.getHeldIndex() >= 0) {
        this.ui.setWheelStatus("Let go of the handle first");
        return;
      }
      this.ui.setWheelStatus(this.handles.undo()
        ? "Undid the last change"
        : "Nothing to undo");
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
      // The bench exists as of P5, so this is a real handoff rather than a
      // placeholder. There is no camera to swing - the stations are fixed in
      // world space at 0 and +60 degrees - so the handoff is to make the bench
      // ready and say plainly where to look.
      this.ui.setGlazeState("WET");
      this.ui.setGlazeStatus("Hold the mic and describe a glaze");
      this.ui.setWheelStatus("Glaze bench ready — look right");
      print("WHEEL: GLAZE handoff - bench primed, awaiting a spoken glaze.");
    });

    // Seed the panel from the mesher's authored starting values.
    this.fluteDepth = this.mesher.fluteDepth;
    this.fluteCount = this.mesher.fluteCount > 0 ? this.mesher.fluteCount : 6;
    this.ui.setTwist(this.mesher.twist / TWO_PI);
    this.ui.setFluteDepth(this.fluteDepth);
    this.ui.setFluteCount(this.fluteCount);
  }
}
