/**
 * WHEEL - Spin
 *
 * Slowly rotates the SceneObject this component sits on around its local Y
 * axis. Used to show the lathed form off from all sides in preview, with no
 * device and no hand tracking involved.
 */
@component
export class Spin extends BaseScriptComponent {
  @input
  @hint("Rotation speed in DEGREES per second (converted to radians at runtime).")
  degreesPerSecond: number = 20;

  private angleDegrees = 0;

  onAwake(): void {
    const transform = this.getTransform();

    this.createEvent("UpdateEvent").bind(() => {
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
}
