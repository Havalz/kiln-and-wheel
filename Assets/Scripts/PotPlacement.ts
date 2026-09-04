/**
 * WHEEL - PotPlacement
 *
 * Grounds a finished pot in the real room. Pinch a fired piece, let go, and it
 * casts down to the nearest real horizontal surface and stands upright on it at
 * true scale.
 *
 * ONLY HORIZONTAL SURFACES COUNT. A hit is accepted when its normal is within
 * MAX_TILT_DEG of world up - a pot does not sit on a wall, and WorldQuery will
 * happily return wall and ceiling hits if you do not filter them.
 *
 * THE FALLBACK IS THE DEMO PATH. WorldQuery is depth-backed and returns null
 * whenever the ray leaves the camera's view - and Lens Studio Preview streams no
 * depth at all, so in the simulator EVERY cast misses. The fallback placement is
 * therefore not an edge case; it is what a recorded demo will actually show, and
 * it is logged loudly so nobody mistakes it for a real surface hit.
 */

import {KilnStation} from "./KilnStation";

/** A hit steeper than this is a wall or ceiling, not something to stand a pot on. */
const MAX_TILT_DEG = 25;
/** Ignore surfaces further than this. */
const MAX_RANGE_CM = 300;
/** Fallback pose when nothing is found: 70cm ahead, 75cm off the floor. */
const FALLBACK_FORWARD_CM = 70;
const FALLBACK_HEIGHT_CM = 75;

@component
export class PotPlacement extends BaseScriptComponent {
  @ui.label("Pot placement — snap to a real surface")
  @ui.separator
  @input @hint("The pot to place.") pot: SceneObject;
  @input @allowUndefined @hint("Only a fired piece can be placed.") kiln: KilnStation;

  @input
  @hint("Assumed floor height relative to the user, in cm, used only by the fallback.")
  @widget(new SliderWidget(-200, 0, 5))
  assumedFloorY: number = -120;

  private worldQuery: any = require("LensStudio:WorldQueryModule");
  private session: any = null;
  private placed = false;

  onAwake(): void {
    // Session creation belongs in OnStartEvent, not onAwake.
    this.createEvent("OnStartEvent").bind(() => this.onStart());
  }

  private onStart(): void {
    if (!this.pot) {
      print("[Place] no pot assigned - placement inert.");
      return;
    }
    try {
      const options = HitTestSessionOptions.create();
      options.filter = true;   // smooths the ~5Hz hit stream
      this.session = this.worldQuery.createHitTestSessionWithOptions(options);
      // Without start() the session silently returns nothing forever.
      this.session.start();
    } catch (e) {
      print("[Place] could not start hit-test session: " + e);
      this.session = null;
    }
  }

  // ── Public ────────────────────────────────────────────────────────────────

  hasPlaced(): boolean {
    return this.placed;
  }

  /**
   * Drop the pot onto the room. Called on release. Casts straight down from
   * just above the pot; on any miss, falls back to a fixed pose in front of the
   * user so a demo can never stall on an empty room.
   */
  place(): void {
    if (this.kiln && !this.kiln.isFired()) {
      print("[Place] piece is not fired yet - not placing.");
      return;
    }
    const tr = this.pot.getTransform();
    const from = tr.getWorldPosition();
    // Cast from slightly above the pot straight down, MAX_RANGE_CM deep.
    const rayStart = new vec3(from.x, from.y + 20, from.z);
    const rayEnd = new vec3(from.x, from.y - MAX_RANGE_CM, from.z);

    if (!this.session) {
      this.placeFallback("no hit-test session");
      return;
    }

    this.session.hitTest(rayStart, rayEnd, (result: any) => {
      if (!result) {
        // Null means the ray left the camera's view or there is no depth.
        this.placeFallback("no surface within " + (MAX_RANGE_CM / 100) + "m");
        return;
      }
      const n = result.normal.normalize();
      const tiltCos = Math.abs(n.dot(vec3.up()));
      const tiltDeg = Math.acos(Math.min(1, tiltCos)) * 180 / Math.PI;
      if (tiltDeg > MAX_TILT_DEG) {
        this.placeFallback("nearest surface was vertical (" + tiltDeg.toFixed(0) + " deg off level)");
        return;
      }
      this.snapUpright(result.position);
      print("[Place] placed on real surface at " + result.position +
            " (" + tiltDeg.toFixed(1) + " deg off level)");
    });
  }

  // ── Placement ─────────────────────────────────────────────────────────────

  /**
   * Stand the pot on a point. Rotation is reset to upright rather than aligned
   * to the surface normal: a thrown pot stands vertically even on a surface
   * with a slight slope, and matching a noisy normal makes it look drunk.
   */
  private snapUpright(position: vec3): void {
    const tr = this.pot.getTransform();
    tr.setWorldPosition(position);
    tr.setWorldRotation(quat.quatIdentity());
    // True real-world scale: the lathe already builds in centimetres, so the
    // pot is its authored size and must not be rescaled to "fit".
    tr.setWorldScale(new vec3(1, 1, 1));
    this.placed = true;
  }

  private placeFallback(reason: string): void {
    // 70cm ahead of the user at 75cm off the assumed floor.
    const y = this.assumedFloorY + FALLBACK_HEIGHT_CM;
    const pos = new vec3(0, y, -FALLBACK_FORWARD_CM);
    this.snapUpright(pos);
    print("[Place] FALLBACK USED (" + reason + ") - placed 70cm ahead at 75cm height. " +
          "This is expected in Lens Studio Preview, which streams no depth.");
  }
}
