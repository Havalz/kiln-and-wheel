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
import {WheelStudioUI} from "./WheelStudioUI";
import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";

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
  @allowUndefined
  @hint("Panel to report placement on. Without it the outcome only reaches the Logger.")
  ui: WheelStudioUI;

  @input
  @allowUndefined
  @hint("The wheel's Spin. Stopped on placement — a pot standing on a table does not turn.")
  spin: ScriptComponent;

  @ui.group_start("Grab volume")
  @input
  @hint("Height of the pot in cm. The grab capsule is built to match it.")
  grabHeight: number = 22.0;

  @input
  @hint("Widest radius of the pot in cm.")
  grabRadius: number = 7.0;
  @ui.group_end

  @input
  @hint("Assumed floor height relative to the user, in cm, used only by the fallback.")
  @widget(new SliderWidget(-200, 0, 5))
  assumedFloorY: number = -120;

  private worldQuery: any = require("LensStudio:WorldQueryModule");
  private session: any = null;
  private placed = false;
  private grab: Interactable = null;

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

    this.buildGrab();
  }

  /**
   * Make the pot itself pinchable. The collider lives on a CHILD rather than on
   * the pot, because the lathe's origin sits at the foot (local y runs 0..height)
   * while a capsule is centred on its object - the child carries the half-height
   * offset so the volume actually wraps the pot.
   *
   * The capsule's axis is Y, so the volume is invariant under the wheel's spin.
   * A box would wobble as the pot turned.
   */
  private buildGrab(): void {
    const host = global.scene.createSceneObject("PotGrab");
    host.setParent(this.pot);
    host.getTransform().setLocalPosition(new vec3(0, this.grabHeight / 2, 0));

    const collider = host.createComponent("Physics.ColliderComponent") as any;
    const shape = Shape.createCapsuleShape();
    shape.axis = Axis.Y;
    shape.radius = this.grabRadius;
    // length is the distance between the two end-cap CENTRES, so the caps add
    // radius at each end and the total comes to grabHeight.
    shape.length = Math.max(0.1, this.grabHeight - this.grabRadius * 2);
    collider.shape = shape;
    collider.debugDrawEnabled = false;

    this.grab = host.createComponent(Interactable.getTypeName()) as Interactable;
    this.grab.targetingMode = 3; // Direct + Indirect: pinch on device, click in Editor.

    // Release, not press, is what drops the pot. onTriggerEndOutside and
    // onTriggerCanceled are bound too: letting go while the cursor has drifted
    // off the pot is still letting go, and without them the pot would be stuck
    // held with no way to drop it.
    const drop = () => this.onReleased();
    this.grab.onTriggerEnd.add(drop);
    this.grab.onTriggerEndOutside.add(drop);
    this.grab.onTriggerCanceled.add(drop);

    // A wet pot is not grabbable: the eight shaping handles occupy the same
    // volume, and a pot collider live at the same time would steal their grabs.
    if (this.kiln) {
      this.grab.enabled = this.kiln.isFired();
      this.kiln.onFired.add(() => {
        this.grab.enabled = true;
        print("[Place] piece fired - pot is now grabbable.");
      });
    } else {
      this.grab.enabled = true;
    }
  }

  private onReleased(): void {
    if (this.kiln && !this.kiln.isFired()) return;
    print("[Place] released - dropping the piece.");
    this.place();
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
      this.say("Fire it first — wet clay can't be set down.");
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
      this.say("Set down on the surface below.");
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
    // A pot standing on a table does not keep turning. The wheel's spin is a
    // throwing affordance and it has no meaning once the piece is in the room.
    if (this.spin) this.spin.enabled = false;
    this.placed = true;
  }

  /** One short sentence on the panel. Never the reason string - that is log detail. */
  private say(message: string): void {
    if (this.ui) this.ui.setKilnStatus(message);
  }

  private placeFallback(reason: string): void {
    // 70cm ahead of the user at 75cm off the assumed floor.
    const y = this.assumedFloorY + FALLBACK_HEIGHT_CM;
    const pos = new vec3(0, y, -FALLBACK_FORWARD_CM);
    this.snapUpright(pos);
    // The user gets the outcome, not the diagnosis: "no surface within 3m" is
    // true but means nothing to someone holding a pot.
    this.say("No surface found — set it down in front of you.");
    print("[Place] FALLBACK USED (" + reason + ") - placed 70cm ahead at 75cm height. " +
          "This is expected in Lens Studio Preview, which streams no depth.");
  }
}
