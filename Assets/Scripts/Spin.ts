/**
 * WHEEL - Spin
 *
 * Slowly rotates the SceneObject this component sits on around its local Y
 * axis. Used to show the lathed form off from all sides in preview, with no
 * device and no hand tracking involved.
 *
 * The wheel stops while the silhouette is being shaped: it polls LatheMesher's
 * dragging state rather than taking a reference to ProfileHandles, which keeps
 * the dependency pointing at core/ and avoids a cycle.
 */

import {LatheMesher} from "./core/LatheMesher";

@component
export class Spin extends BaseScriptComponent {
  @input
  @hint("Rotation speed in DEGREES per second (converted to radians at runtime).")
  degreesPerSecond: number = 20;

  private angleDegrees = 0;
  private paused = false;
  private mesher: LatheMesher;

  onAwake(): void {
    const transform = this.getTransform();
    this.mesher = this.findMesher();

    this.createEvent("UpdateEvent").bind(() => {
      if (this.paused || (this.mesher && this.mesher.isDragging())) {
        return;
      }

      this.angleDegrees += this.degreesPerSecond * getDeltaTime();

      // Keep the accumulator bounded so float precision does not drift over
      // long sessions.
      if (this.angleDegrees >= 360 || this.angleDegrees <= -360) {
        this.angleDegrees = this.angleDegrees % 360;
      }

      // The Editor API works in degrees, but the Lens runtime takes RADIANS.
      const angleRadians = this.angleDegrees * (Math.PI / 180);
      transform.setLocalRotation(quat.angleAxis(angleRadians, vec3.up()));
    });
  }

  /** Explicit pause, independent of the dragging state. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  private findMesher(): LatheMesher {
    const comps = this.sceneObject.getComponents("ScriptComponent") as any[];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      if (c && typeof c.isDragging === "function" && typeof c.getModel === "function") {
        return c as LatheMesher;
      }
    }
    return null;
  }
}
