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
 * CAST INSIDE THE VIEWED REGION. WorldQuery samples a depth map that only
 * covers what the camera can see, and returns null for any ray outside the
 * field of view. An earlier version cast straight DOWN from the pot - a three
 * metre vertical segment that leaves the frustum almost immediately - and so
 * never got a single hit. It is not that Preview lacks depth: the docs list
 * Interactive Preview as a supported environment, and EXPERIMENTAL_API is
 * needed only for semantic classification, which this does not use. The ray was
 * simply pointed where there is no data.
 *
 * The gesture stays a DROP, not a point-and-place: you pinch the pot and let
 * go. So the probe runs from near the eye out and DOWNWARD into the view, and
 * sweeps its angle across successive frames rather than betting everything on
 * one sample - a single out-of-view frame should not commit the piece to the
 * fallback forever.
 */

import {KilnStation} from "./KilnStation";
import {WheelStudioUI} from "./WheelStudioUI";
import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import {isTap} from "./core/TapGesture";

/** A hit steeper than this is a wall or ceiling, not something to stand a pot on. */
const MAX_TILT_DEG = 25;
/** Longest probe the sweep can produce, for the fallback message only. */
const MAX_RANGE_CM = 300;
/** Fallback pose when nothing is found: 70cm ahead, 75cm off the floor. */
const FALLBACK_FORWARD_CM = 70;
const FALLBACK_HEIGHT_CM = 75;

/** Frames the probe gets before giving up. ~0.4s at 30fps. */
const PROBE_ATTEMPTS = 12;
/** Start the ray slightly ahead of the eye rather than inside the head. */
const PROBE_NEAR_CM = 15;
/** How far forward the probe reaches for a surface. */
const PROBE_FORWARD_CM = 85;
/**
 * Downward sweep, in cm below the view axis at PROBE_FORWARD_CM. The span is
 * deliberately shallow: 20cm at 85cm forward is ~13 degrees below the axis and
 * 95cm is ~48, so the sweep stays inside a plausible FOV at the near end and
 * only risks leaving it at the far end. Sweeping is what turns the retry budget
 * into coverage instead of twelve identical misses.
 */
const PROBE_DROP_MIN_CM = 20;
const PROBE_DROP_MAX_CM = 95;
/** Breathing room between the placed vessel and any station plate, in cm. */
const PANEL_CLEAR_MARGIN_CM = 3.0;
/** Separation passes; clearing one plate can nudge the pot into its neighbour. */
const PANEL_CLEAR_PASSES = 4;

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
  @hint("TEMPORARY diagnostic: cast short raw rays and log every result unfiltered.")
  runDepthProbeNow: boolean = false;

  @input
  @hint("TEMPORARY diagnostic: Physics.Probe raycast grid against scene COLLIDERS, not depth.")
  runPhysicsProbeNow: boolean = false;

  @input
  @allowUndefined
  @hint("The camera the probe casts from. Depth only exists where this looks; without it placement falls back immediately.")
  camera: SceneObject;

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
  private pressTime = 0;
  private pressPoint: vec3 = null;
  private probesLeft = 0;
  private probing = false;
  private awaitingCallback = false;

  onAwake(): void {
    // Session creation belongs in OnStartEvent, not onAwake.
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
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

    // A QUICK TAP IS NOT A DROP. Binding placement to onTriggerEnd alone made
    // every ping test also fling the pot, because a tap and a placement end the
    // same way. Press is recorded, release is classified, and only a held or
    // dragged gesture places; see core/TapGesture.
    this.grab.onTriggerStart.add((e: any) => this.onPressed(e));

    // onTriggerEndOutside and onTriggerCanceled are bound too: letting go while
    // the cursor has drifted off the pot is still letting go, and without them
    // the pot would be stuck held with no way to drop it.
    const drop = (e: any) => this.onReleased(e);
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

  private onPressed(e: any): void {
    this.pressTime = getTime();
    this.pressPoint = this.interactorPoint(e);
  }

  private onReleased(e: any): void {
    if (this.kiln && !this.kiln.isFired()) return;

    const held = this.pressTime > 0 ? getTime() - this.pressTime : 0;
    const end = this.interactorPoint(e);
    const travel = this.pressPoint && end ? this.pressPoint.distance(end) : 0;
    this.pressTime = 0;

    if (isTap({heldSeconds: held, travelCm: travel})) {
      // Inspection only. The bell is played by WheelAudio off its own
      // interactable; placement deliberately does nothing here.
      print("[Place] tap (" + held.toFixed(2) + "s, " + travel.toFixed(1) +
            "cm) - ping test, piece not moved.");
      return;
    }
    print("[Place] released after " + held.toFixed(2) + "s / " +
          travel.toFixed(1) + "cm - dropping the piece.");
    this.place();
  }

  /** Where the interactor is right now, for measuring gesture travel. */
  private interactorPoint(e: any): vec3 {
    const io = e && e.interactor ? e.interactor : null;
    if (!io) return null;
    return (io.startPoint as vec3) || (io.planecastPoint as vec3) || null;
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
    if (!this.session) {
      this.placeFallback("no hit-test session");
      return;
    }
    if (!this.camera) {
      this.placeFallback("no camera assigned");
      return;
    }
    // Hand off to onUpdate: the probe needs frames, because one sample from one
    // angle is exactly the mistake that made this never work.
    this.probesLeft = PROBE_ATTEMPTS;
    this.probing = true;
    this.awaitingCallback = false;
    this.say("Looking for a surface…");
  }

  private onUpdate(): void {
    if (this.runDepthProbeNow) {
      this.runDepthProbeNow = false;
      this.depthProbe();
    }
    if (this.runPhysicsProbeNow) {
      this.runPhysicsProbeNow = false;
      this.physicsProbe();
    }
    if (!this.probing || this.awaitingCallback) return;
    if (this.probesLeft <= 0) {
      this.probing = false;
      this.placeFallback("no surface found in view after " + PROBE_ATTEMPTS + " probes");
      return;
    }
    this.probesLeft--;
    this.probeOnce();
  }

  /**
   * DIAGNOSTIC ONLY. Does anything in this scene carry a COLLIDER that
   * Physics.Probe can hit? A completely different mechanism from WorldQuery:
   * colliders, not depth.
   *
   * Casts a grid of long downward rays over the area in front of the user
   * rather than guessing where the coffee table is. Our own objects - the pot,
   * its grab capsule, the UI panels - do carry colliders, so a hit on one of
   * those is a POSITIVE CONTROL proving the probe works; only then does the
   * absence of environment hits mean the room has no colliders.
   */
  private physicsProbe(): void {
    let probe: any = null;
    try {
      probe = (Physics as any).createGlobalProbe();
    } catch (e) {
      print("[Phys] could not create global probe: " + e);
      return;
    }
    if (!probe) { print("[Phys] createGlobalProbe returned null"); return; }

    const xs = [-40, 0, 40];
    const zs = [-40, -70, -100, -130];
    print("[Phys] casting " + (xs.length * zs.length) + " downward rays, y +50 -> -250");
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < zs.length; j++) {
        const x = xs[i];
        const z = zs[j];
        const start = new vec3(x, 50, z);
        const end = new vec3(x, -250, z);
        probe.rayCast(start, end, (hit: any) => {
          if (!hit) {
            print("[Phys] (" + x + ", " + z + ") -> NULL");
            return;
          }
          let who = "?";
          try {
            who = hit.collider ? hit.collider.getSceneObject().name : "(no collider ref)";
          } catch (e) {}
          print("[Phys] (" + x + ", " + z + ") -> HIT " + who +
                " pos=" + hit.position + " normal=" + hit.normal);
        });
      }
    }
  }

  /**
   * DIAGNOSTIC ONLY. Does this scene answer WorldQuery at all? Casts a spread of
   * short rays from the eye and logs every raw result with NO tilt filtering, so
   * a null here means the query returned nothing rather than that we rejected a
   * wall. If even a 30cm ray straight ahead is null, there is no depth to query
   * and no amount of ray tuning will ever help.
   */
  private depthProbe(): void {
    if (!this.session) { print("[Probe] no hit-test session"); return; }
    if (!this.camera) { print("[Probe] no camera assigned"); return; }
    const tr = this.camera.getTransform();
    const eye = tr.getWorldPosition();
    const rot = tr.getWorldRotation();
    const view = rot.multiplyVec3(new vec3(0, 0, -1)).normalize();
    const down = new vec3(0, -1, 0);
    const start = eye.add(view.uniformScale(5));

    print("[Probe] eye=" + eye + "  view=" + view);
    const cases: {name: string; end: vec3}[] = [
      {name: "fwd 30cm ", end: eye.add(view.uniformScale(30))},
      {name: "fwd 60cm ", end: eye.add(view.uniformScale(60))},
      {name: "fwd 120cm", end: eye.add(view.uniformScale(120))},
      {name: "fwd 300cm", end: eye.add(view.uniformScale(300))},
      {name: "down 60cm", end: eye.add(down.uniformScale(60))},
      {name: "fwd60+dn30", end: eye.add(view.uniformScale(60)).add(down.uniformScale(30))},
      {name: "fwd85+dn45", end: eye.add(view.uniformScale(85)).add(down.uniformScale(45))}
    ];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      this.session.hitTest(start, c.end, (r: any) => {
        if (!r) {
          print("[Probe] " + c.name + " -> NULL");
        } else {
          print("[Probe] " + c.name + " -> HIT pos=" + r.position + " normal=" + r.normal);
        }
      });
    }
  }

  /**
   * One ray, from just ahead of the eye to a point forward and below it. The
   * drop sweeps from shallow to steep across attempts, so successive frames
   * cover a fan of angles through the viewed region instead of re-asking the
   * same question.
   */
  private probeOnce(): void {
    const tr = this.camera.getTransform();
    const eye = tr.getWorldPosition();
    const rot = tr.getWorldRotation();
    // A camera with identity rotation looks down world -Z.
    const view = rot.multiplyVec3(new vec3(0, 0, -1)).normalize();

    const done = PROBE_ATTEMPTS - this.probesLeft - 1;
    const t = PROBE_ATTEMPTS > 1 ? done / (PROBE_ATTEMPTS - 1) : 0;
    const drop = PROBE_DROP_MIN_CM + (PROBE_DROP_MAX_CM - PROBE_DROP_MIN_CM) * t;

    const start = eye.add(view.uniformScale(PROBE_NEAR_CM));
    const end = eye
      .add(view.uniformScale(PROBE_FORWARD_CM))
      .add(new vec3(0, -drop, 0));

    this.awaitingCallback = true;
    this.session.hitTest(start, end, (result: any) => {
      this.awaitingCallback = false;
      if (!this.probing) return;
      if (!result) return;   // out of view or nothing there - the next frame tries a new angle

      const n = result.normal.normalize();
      const tiltCos = Math.abs(n.dot(vec3.up()));
      const tiltDeg = Math.acos(Math.min(1, tiltCos)) * 180 / Math.PI;
      if (tiltDeg > MAX_TILT_DEG) {
        // A wall or the ceiling. Keep sweeping rather than standing a pot on it.
        return;
      }
      this.probing = false;
      this.snapUpright(result.position);
      this.say("Set down on the surface below.");
      print("[Place] HIT on real surface at " + result.position +
            " (" + tiltDeg.toFixed(1) + " deg off level, drop " +
            drop.toFixed(0) + "cm, probe " + (done + 1) + "/" + PROBE_ATTEMPTS + ")");
    });
  }

  // ── Placement ─────────────────────────────────────────────────────────────

  /**
   * Stand the pot on a point. Rotation is reset to upright rather than aligned
   * to the surface normal: a thrown pot stands vertically even on a surface
   * with a slight slope, and matching a noisy normal makes it look drunk.
   */
  private snapUpright(position: vec3): void {
    const safe = this.pushClearOfPanels(position);
    const tr = this.pot.getTransform();
    tr.setWorldPosition(safe);
    tr.setWorldRotation(quat.quatIdentity());
    // True real-world scale: the lathe already builds in centimetres, so the
    // pot is its authored size and must not be rescaled to "fit".
    tr.setWorldScale(new vec3(1, 1, 1));
    // A pot standing on a table does not keep turning. The wheel's spin is a
    // throwing affordance and it has no meaning once the piece is in the room.
    if (this.spin) this.spin.enabled = false;
    this.placed = true;
  }

  /**
   * NO VESSEL SLICED BY A UI PLATE. Every placement path funnels through
   * snapUpright, so the guard lives here rather than at each call site.
   *
   * The pot is treated as an upright box (its grab capsule's footprint) and
   * tested against each station plate's own mesh bounds - the visible plate,
   * not its interaction volume, which is far larger and would shove the pot
   * needlessly far. On an overlap the pot slides HORIZONTALLY away from that
   * panel's centre by just enough to separate, plus a margin. Horizontal
   * because the panels ring the user: sideways or toward them is always open
   * space, whereas lifting the pot would leave it hanging in mid-air.
   */
  private pushClearOfPanels(position: vec3): vec3 {
    if (!this.ui) return position;
    const panels = this.ui.getPanelRoots();
    if (!panels || panels.length === 0) return position;

    let px = position.x;
    let pz = position.z;
    const halfW = this.grabRadius + PANEL_CLEAR_MARGIN_CM;
    const yLo = position.y;
    const yHi = position.y + this.grabHeight;

    // A few passes: clearing one panel can nudge the pot into its neighbour.
    for (let pass = 0; pass < PANEL_CLEAR_PASSES; pass++) {
      let moved = false;
      for (let i = 0; i < panels.length; i++) {
        const vis = panels[i].getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (!vis) continue;
        const lo = vis.worldAabbMin();
        const hi = vis.worldAabbMax();

        // Vertical miss means no overlap at all, whatever the footprint does.
        if (yHi < lo.y || yLo > hi.y) continue;

        const overlapX = Math.min(px + halfW, hi.x) - Math.max(px - halfW, lo.x);
        const overlapZ = Math.min(pz + halfW, hi.z) - Math.max(pz - halfW, lo.z);
        if (overlapX <= 0 || overlapZ <= 0) continue;

        // Separate along whichever horizontal axis needs the least travel.
        const cx = (lo.x + hi.x) * 0.5;
        const cz = (lo.z + hi.z) * 0.5;
        if (overlapX < overlapZ) {
          px += px >= cx ? overlapX : -overlapX;
        } else {
          pz += pz >= cz ? overlapZ : -overlapZ;
        }
        moved = true;
      }
      if (!moved) break;
    }

    if (px !== position.x || pz !== position.z) {
      print("[Place] panel guard moved the piece from x=" + position.x.toFixed(1) +
            " z=" + position.z.toFixed(1) + " to x=" + px.toFixed(1) +
            " z=" + pz.toFixed(1) + " to keep it clear of the plates.");
      return new vec3(px, position.y, pz);
    }
    return position;
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
          "Preview IS a supported environment for WorldQuery, so this is not " +
          "proof that placement is broken - it means no surface answered along " +
          "the swept probe here. Untested on device.");
  }
}
