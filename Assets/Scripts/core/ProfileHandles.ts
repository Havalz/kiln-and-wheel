/**
 * WHEEL - ProfileHandles
 *
 * Spawns one grabbable handle per profile control point and lets the user
 * reshape the silhouette by pinching them.
 *
 * Attach to the same SceneObject as LatheMesher. The handles are NOT children of
 * that object: they live under a separate, non-spinning rig that holds station
 * in world space while the vessel turns beneath it -- the way a potter's hands
 * stay put while the wheel spins. Parenting them to the spinning lathe makes
 * them an un-grabbable moving target, and also measures the drag delta in a
 * rotating frame. Radius is rotation-invariant, so a stationary handle plane
 * maps to the profile perfectly well.
 *
 * INTERACTION MODEL
 * -----------------
 * Built on SIK's Interactable rather than raw HandInputData. That matters: SIK
 * dual-paths Interactables through MouseInteractor in the Editor and
 * HandInteractor on device, so this whole interaction is testable in preview
 * with no headset and needs NO manual touch mock. Do not add one -- a manual
 * TouchStartEvent mock on top of Interactable double-fires in the Editor.
 *
 * Dragging is delta-based: we record the interactor point and the point's
 * profile coordinates at grab time, then apply the accumulated delta. Absolute
 * tracking would snap the handle to wherever the ray happens to land.
 */

import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import {InteractorEvent} from "SpectaclesInteractionKit.lspkg/Core/Interactor/InteractorEvent";

import {CONTROL_POINTS, ProfileModel} from "./ProfileModel";
import type {ProfilePoint} from "./ProfileModel";
import {LatheMesher} from "./LatheMesher";
import {ProfileUndoStack} from "./ProfileUndoStack";

/** Radius clamp, in normalized profile units. */
const MIN_RADIUS = 0.02;
const MAX_RADIUS = 1.0;

/**
 * Minimum normalized gap kept between neighbouring control points. ProfileModel
 * re-sorts by y on every setPoint, so letting two points meet would reorder the
 * array and silently break the handle-to-index mapping.
 */
const MIN_Y_GAP = 0.005;

/**
 * Collider radius in the handle's LOCAL units (the object scale multiplies it
 * again). Slightly wider than the 1-unit sphere mesh so the grab volume is a
 * little more forgiving than the dot the user sees.
 */
/**
 * Grab sphere radius in the handle's LOCAL units, multiplied again by the
 * object's own scale. Generous on purpose: a control you have to aim at
 * precisely is a control you fight.
 */
/** Rows in the drag-time segment highlight. */
const SEG_ROWS = 20;
/** How far the highlight floats off the surface so it never z-fights, in cm. */
const SEG_LIFT_CM = 0.35;
/** Width of the highlight band and of a leader line, in cm. */
const SEG_BAND_CM = 0.9;
const LEADER_W_CM = 0.28;

const GRAB_RADIUS_LOCAL = 2.3;

/** Per-handle runtime state. */
class Handle {
  index: number;
  object: SceneObject;
  transform: Transform;
  material: Material;
  interactable: Interactable;

  hovered = false;
  held = false;

  /** Smoothed scale multiplier, eased toward the hover/rest target. */
  scaleMul = 1;

  /** Thin leader line from the point on the form back to its offset grip. */
  leader: SceneObject = null;
  leaderTransform: Transform = null;
  leaderMat: Material = null;

  // Grab bookkeeping, valid only while held.
  activeInteractor: any = null;
  grabLocal: vec3 = vec3.zero();
  grabY = 0;
  grabR = 0;
  /** Distance from the interactor's ray locus to the handle at grab time. */
  grabDist = 0;
}

@component
export class ProfileHandles extends BaseScriptComponent {
  @input
  @allowUndefined
  @hint("Sphere mesh shared by all 8 handles.")
  handleMesh: RenderMesh;

  @input
  @allowUndefined
  @hint("Bright unlit material. Cloned per handle so hover only lights one.")
  handleMaterial: Material;

  @input
  @hint("TEMPORARY: dump every handle's state and ray-test what occludes it. Auto-clears.")
  runHandleDiagnosticsNow: boolean = false;

  @input
  @hint("Hand travel to profile change. 1.0 is literal 1:1 - a centimetre of hand is a centimetre of radius - which proved too twitchy to dial in a subtle curve. Half of that still tracks the hand directly without flinging the profile across its whole range.")
  @widget(new SliderWidget(0.15, 1.5, 0.05))
  dragSensitivity: number = 0.5;

  @input
  @hint("Handle sphere radius in centimetres.")
  handleRadius: number = 1.15;

  @input
  @hint("Scale multiplier applied while a handle is hovered.")
  hoverScale: number = 1.9;

  @input
  @hint("Centimetres to float each handle outward past the surface, so it is grabbable instead of half-buried in the mesh.")
  handleOffset: number = 4.2;

  @input
  @hint("Print hover/grab events to the Logger panel. For manual pinch testing in the simulator; leave off in normal use.")
  debugLog: boolean = false;

  private mesher: LatheMesher;
  private model: ProfileModel;

  /** Non-spinning parent for the handles. Tracks the lathe's world position. */
  private rig: SceneObject;
  private rigTransform: Transform;
  private readonly undoStack = new ProfileUndoStack();
  private readonly handles: Handle[] = [];
  private heldCount = 0;
  private warned = false;
  private segBuilder: MeshBuilder = null;
  private segObject: SceneObject = null;
  private segMat: Material = null;
  private readonly segVtx: number[] = [0, 0, 0, 0, 0, 1, 0, 0];
  private editable = true;

  onAwake(): void {
    // Component lookup is safe in onAwake; SIK event binding is not (see below).
    this.mesher = this.findMesher();

    this.createEvent("OnStartEvent").bind(() => {
      this.onStart();
    });

    this.createEvent("UpdateEvent").bind(() => {
      this.onUpdate();
    });
  }

  private onStart(): void {
    if (!this.mesher) {
      print("ProfileHandles: no LatheMesher on this SceneObject - handles disabled.");
      return;
    }
    this.model = this.mesher.getModel();

    this.buildHandles();
    this.layoutHandles();

    if (this.debugLog) {
      print("[WHEEL] handles ready: " + this.handles.length + " (debugLog on)");
    }

    // Baseline, so the first undo returns to the starting silhouette.
    this.undoStack.push(this.model.serialize());

    // Any change to the model (drag, undo, external edit) repositions handles.
    this.model.onChanged.add(() => {
      this.layoutHandles();
    });
  }

  // ---------------------------------------------------------------- public

  /**
   * Hide the handles and stop them responding. A fired pot is finished clay -
   * it cannot be reshaped, so the affordance goes away entirely rather than
   * staying visible but inert.
   */
  setEditable(editable: boolean): void {
    this.editable = editable;
    for (let i = 0; i < this.handles.length; i++) {
      this.handles[i].object.enabled = editable;
      // The leader belongs to its grip: a fired piece has no controls, so it
      // must not be left with orphan lines pointing at nothing.
      if (this.handles[i].leader) this.handles[i].leader.enabled = editable;
    }
    if (this.segObject && !editable) this.segObject.enabled = false;
    if (!editable && this.heldCount > 0) {
      this.heldCount = 0;
      this.mesher.setDragging(false);
    }
  }

  isEditable(): boolean {
    return this.editable;
  }

  /** True while at least one handle is pinched. Spin polls this indirectly. */
  isAnyHeld(): boolean {
    return this.heldCount > 0;
  }

  /**
   * Index of the handle currently being dragged, or -1 when idle. The wheel hum
   * follows this: it is the control point the potter's hands are on.
   */
  getHeldIndex(): number {
    for (let i = 0; i < this.handles.length; i++) {
      if (this.handles[i].held) return i;
    }
    return -1;
  }

  canUndo(): boolean {
    return this.undoStack.canUndo();
  }

  /**
   * Restore the previous snapshot. Public and unbound: there is no gesture or
   * button wired to it yet -- that arrives with the UI pass.
   */
  undo(): boolean {
    if (this.heldCount > 0) {
      return false;
    }
    const previous = this.undoStack.undo();
    if (previous === null) {
      return false;
    }
    this.model.deserialize(previous);
    return true;
  }

  // --------------------------------------------------------------- private

  /** Gated by the debugLog input so normal runs stay quiet. */
  private log(event: string, index: number): void {
    if (this.debugLog) {
      print("[WHEEL] " + event + " handle=" + index);
    }
  }

  private findMesher(): LatheMesher {
    const comps = this.sceneObject.getComponents("ScriptComponent") as any[];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      // Duck-typed rather than instanceof: survives module identity quirks.
      if (c && typeof c.getModel === "function" && typeof c.setDragging === "function") {
        return c as LatheMesher;
      }
    }
    return null;
  }

  private buildHandles(): void {
    if (!this.handleMesh || !this.handleMaterial) {
      print("ProfileHandles: handleMesh/handleMaterial not assigned - handles disabled.");
      return;
    }

    // Deliberately left at the scene root rather than parented to the lathe,
    // so it never inherits the spin. syncRig() keeps it on the vessel.
    this.rig = global.scene.createSceneObject("WHEEL Handle Rig");
    this.rigTransform = this.rig.getTransform();
    this.syncRig();

    for (let i = 0; i < CONTROL_POINTS; i++) {
      const h = new Handle();
      h.index = i;

      h.object = global.scene.createSceneObject("Handle_" + i);
      h.object.setParent(this.rig);
      h.transform = h.object.getTransform();

      const visual = h.object.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      visual.mesh = this.handleMesh;
      // Cloned so hover brightening affects one handle, not all eight.
      h.material = this.handleMaterial.clone();
      visual.clearMaterials();
      visual.addMaterial(h.material);

      const collider = h.object.createComponent("Physics.ColliderComponent") as any;
      const shape = Shape.createSphereShape();
      // Shape radius is in LOCAL units and is scaled again by the object's own
      // scale, so this must NOT be handleRadius or the size double-applies.
      // Slightly larger than the visual sphere for a forgiving grab volume.
      shape.radius = GRAB_RADIUS_LOCAL;
      collider.shape = shape;
      collider.debugDrawEnabled = false;

      h.interactable = h.object.createComponent(Interactable.getTypeName()) as Interactable;
      h.interactable.targetingMode = 3; // Direct + Indirect: pinch on device, click in Editor.

      h.leader = global.scene.createSceneObject("HandleLeader_" + i);
      h.leader.setParent(this.rig);
      h.leaderTransform = h.leader.getTransform();
      const lv = h.leader.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      lv.mesh = this.unitQuad();
      h.leaderMat = this.handleMaterial.clone();
      lv.clearMaterials();
      lv.addMaterial(h.leaderMat);

      this.handles.push(h);
    }
    this.buildSegment();

    // SIK events bind in OnStartEvent only. buildHandles() is already called
    // from OnStartEvent, so binding inline here is correct.
    for (let i = 0; i < this.handles.length; i++) {
      this.bindHandle(this.handles[i]);
    }
  }

  /**
   * A 1x1 quad on the XY plane with its origin at the LEFT edge, so scaling X
   * grows it along its own length from the anchored end.
   */
  private unitQuad(): RenderMesh {
    const b = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    b.topology = MeshTopology.Triangles;
    b.indexType = MeshIndexType.UInt16;
    b.appendVerticesInterleaved([
      0, -0.5, 0,  0, 0, 1,  0, 0,
      1, -0.5, 0,  0, 0, 1,  1, 0,
      0,  0.5, 0,  0, 0, 1,  0, 1,
      1,  0.5, 0,  0, 0, 1,  1, 1
    ]);
    b.appendIndices([0, 1, 2, 2, 1, 3]);
    b.updateMesh();
    return b.getMesh();
  }

  /**
   * The stretch of silhouette a handle owns: from the midpoint to its lower
   * neighbour up to the midpoint to its upper one. Shown only while dragging,
   * so the user can see WHICH part of the form is answering the hand.
   */
  private buildSegment(): void {
    this.segBuilder = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    this.segBuilder.topology = MeshTopology.Triangles;
    this.segBuilder.indexType = MeshIndexType.UInt16;
    const zeros: number[] = new Array(SEG_ROWS * 2 * 8);
    for (let i = 0; i < zeros.length; i++) zeros[i] = 0;
    this.segBuilder.appendVerticesInterleaved(zeros);
    const idx: number[] = [];
    for (let r = 0; r < SEG_ROWS - 1; r++) {
      const a = r * 2;
      idx.push(a, a + 1, a + 2);
      idx.push(a + 2, a + 1, a + 3);
    }
    this.segBuilder.appendIndices(idx);

    this.segObject = global.scene.createSceneObject("HandleSegment");
    this.segObject.setParent(this.rig);
    const v = this.segObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    v.mesh = this.segBuilder.getMesh();
    this.segMat = this.handleMaterial.clone();
    v.clearMaterials();
    v.addMaterial(this.segMat);
    this.segObject.enabled = false;
  }

  private bindHandle(h: Handle): void {
    h.interactable.onHoverEnter.add(() => {
      h.hovered = true;
      this.log("hoverEnter", h.index);
    });
    h.interactable.onHoverExit.add(() => {
      h.hovered = false;
      this.log("hoverExit", h.index);
    });

    h.interactable.onTriggerStart.add((e: InteractorEvent) => {
      this.log("triggerStart", h.index);
      this.beginDrag(h, e);
    });

    const end = (e: InteractorEvent) => {
      this.log("triggerEnd", h.index);
      this.endDrag(h, e);
    };
    h.interactable.onTriggerEnd.add(end);
    h.interactable.onTriggerEndOutside.add(end);
    h.interactable.onTriggerCanceled.add(end);
  }

  /**
   * World point of an interactor. startPoint is the pinch point on device and
   * follows the cursor in the Editor; planecastPoint is the fallback for
   * indirect targeting. Preferring whichever is non-null avoids branching on
   * isEditor(), which would pick wrong when a simulated hand drives preview.
   */
  /**
   * WHY THIS IS NOT JUST `io.startPoint`. For the indirect (far-field)
   * interactor - the one you use to grab a handle at arm's length -
   * `startPoint` is the ray's LOCUS, which SIK anchors near the shoulder. When
   * the hand moves, the ray SWEEPS but the locus barely translates, so reading
   * startPoint gave a drag delta a small fraction of the actual hand travel:
   * the handle crawled and shaping felt damped. Re-projecting the ray out to
   * the distance the handle was grabbed at recovers a point that moves with the
   * hand, which is what makes the handle feel stuck to your fingers.
   */
  private interactorPoint(io: any, h: Handle): vec3 {
    if (!io) {
      return null;
    }
    const start = io.startPoint as vec3;
    const dir = io.direction as vec3;
    if (start && dir && h && h.grabDist > 0) {
      return start.add(dir.uniformScale(h.grabDist));
    }
    // Direct/poke interactors put startPoint on the fingertip, where it already
    // tracks the hand; the planecast is the last resort.
    if (start) {
      return start;
    }
    if (io.planecastPoint) {
      return io.planecastPoint;
    }
    return null;
  }

  /**
   * World point -> rig space. Uses the rig, not the lathe: the rig does not
   * rotate, so a drag delta measured here is not corrupted by the spin.
   */
  private toLocal(worldPoint: vec3): vec3 {
    return this.rigTransform.getInvertedWorldTransform().multiplyPoint(worldPoint);
  }

  /**
   * Keep the rig on the vessel's world position but never rotated with it, so
   * the handles hold station while the lathe turns underneath.
   */
  /**
   * TEMPORARY DIAGNOSTIC. Dumps every handle's real state and, for each one,
   * ray casts from the camera to the handle centre and reports what the ray
   * meets FIRST. If the pot's own collider is in front of a handle, that handle
   * cannot be pinched no matter how healthy its own collider looks.
   */
  private runDiagnostics(): void {
    const cam = this.findCamera();
    if (!cam) {
      print("[HDIAG] no camera found - skipping occlusion test.");
    }
    const eye = cam ? cam.getTransform().getWorldPosition() : null;
    const probe = Physics.createGlobalProbe();
    const pts = this.model.getPoints();

    print("[HDIAG] ---- handle state, radiusScale=" +
          this.mesher.radiusScale.toFixed(2) + " height=" +
          this.mesher.height.toFixed(2) + " ----");

    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i];
      const wp = h.transform.getWorldPosition();
      const scl = h.transform.getWorldScale();
      const effR = GRAB_RADIUS_LOCAL * scl.x;
      const surfaceR = pts[i].r * this.mesher.radiusScale;
      print("[HDIAG] H" + i +
            " pos=(" + wp.x.toFixed(2) + "," + wp.y.toFixed(2) + "," + wp.z.toFixed(2) + ")" +
            " objEnabled=" + h.object.enabled +
            " interEnabled=" + h.interactable.enabled +
            " mode=" + h.interactable.targetingMode +
            " grabR=" + effR.toFixed(2) +
            " surfaceR=" + surfaceR.toFixed(2) +
            " clearance=" + (Math.sqrt(wp.x * wp.x + (wp.z + 45) * (wp.z + 45)) - surfaceR).toFixed(2));

      if (!eye) continue;
      probe.rayCastAll(eye, wp, (hits: RayCastHit[]) => {
        let line = "[HDIAG] H" + i + " ray hits:";
        if (!hits || hits.length === 0) {
          line += " NONE";
        } else {
          for (let k = 0; k < hits.length && k < 4; k++) {
            const o = hits[k].collider ? hits[k].collider.getSceneObject() : null;
            line += " " + (k + 1) + ")" + (o ? o.name : "?") +
                    "@" + hits[k].position.distance(eye).toFixed(1);
          }
        }
        print(line);
      });
    }
  }

  private findCamera(): SceneObject {
    const n = global.scene.getRootObjectsCount();
    for (let i = 0; i < n; i++) {
      const found = this.searchCamera(global.scene.getRootObject(i));
      if (found) return found;
    }
    return null;
  }

  private searchCamera(obj: SceneObject): SceneObject {
    if (obj.getComponent("Component.Camera")) return obj;
    for (let i = 0; i < obj.getChildrenCount(); i++) {
      const found = this.searchCamera(obj.getChild(i));
      if (found) return found;
    }
    return null;
  }

  private syncRig(): void {
    const lathe = this.sceneObject.getTransform();
    this.rigTransform.setWorldPosition(lathe.getWorldPosition());
    this.rigTransform.setWorldRotation(quat.quatIdentity());
  }

  private beginDrag(h: Handle, e: InteractorEvent): void {
    if (h.held || !this.editable) {
      return;
    }
    // Measure the grab distance BEFORE sampling, since the sample depends on it.
    const locus = e.interactor ? (e.interactor.startPoint as vec3) : null;
    h.grabDist = locus
      ? h.transform.getWorldPosition().distance(locus)
      : 0;

    const world = this.interactorPoint(e.interactor, h);
    if (!world) {
      return;
    }

    const pts = this.model.getPoints();
    h.activeInteractor = e.interactor;
    h.grabLocal = this.toLocal(world);
    h.grabY = pts[h.index].y;
    h.grabR = pts[h.index].r;
    h.held = true;

    this.heldCount++;
    if (this.heldCount === 1) {
      this.mesher.setDragging(true);
    }
  }

  private endDrag(h: Handle, e: InteractorEvent): void {
    if (!h.held || (e && e.interactor !== h.activeInteractor)) {
      return;
    }
    h.held = false;
    h.activeInteractor = null;

    this.heldCount--;
    if (this.heldCount <= 0) {
      this.heldCount = 0;
      this.mesher.setDragging(false);
      // Post-edit state. push() ignores a no-op grab.
      this.undoStack.push(this.model.serialize());
    }
  }

  private onUpdate(): void {
    if (!this.mesher || this.handles.length === 0) {
      return;
    }

    if (this.runHandleDiagnosticsNow) {
      this.runHandleDiagnosticsNow = false;
      this.runDiagnostics();
    }

    // Cheap no-op while the vessel stays put; keeps the handles attached if it
    // is ever repositioned.
    this.syncRig();

    let dragging = -1;
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i];
      if (h.held) {
        this.dragHandle(h);
        dragging = i;
      }
      this.updateAppearance(h);
      this.updateLeader(h);
    }
    this.updateSegment(dragging);
  }

  /**
   * The grip floats well clear of the form, so a leader line ties it back to
   * the point it actually controls - otherwise an offset dot is ambiguous about
   * which part of the profile it moves.
   */
  private updateLeader(h: Handle): void {
    if (!h.leaderTransform) return;
    const pts = this.model.getPoints();
    const surfaceR = pts[h.index].r * this.mesher.radiusScale;
    const y = pts[h.index].y * this.mesher.height;
    const len = Math.max(0.01, this.handleOffset);

    h.leaderTransform.setLocalPosition(new vec3(surfaceR, y, 0));
    h.leaderTransform.setLocalScale(new vec3(len, LEADER_W_CM, 1));

    const hot = h.hovered || h.held;
    const a = hot ? 1.0 : 0.42;
    if (h.leaderMat) {
      h.leaderMat.mainPass.baseColor = new vec4(0.35 * a, 0.9 * a, 1.0 * a, a);
    }
  }

  /** Light up the stretch of silhouette the dragged handle owns. */
  private updateSegment(index: number): void {
    if (!this.segObject) return;
    if (index < 0) {
      this.segObject.enabled = false;
      return;
    }
    this.segObject.enabled = true;

    const pts = this.model.getPoints();
    const samples = this.model.getSamples();
    const height = this.mesher.height;
    const radiusScale = this.mesher.radiusScale;

    // Midpoint to each neighbour: the honest extent of this handle's influence.
    const lo = index > 0 ? (pts[index - 1].y + pts[index].y) * 0.5 : 0;
    const hi = index < CONTROL_POINTS - 1
      ? (pts[index].y + pts[index + 1].y) * 0.5 : 1;

    const v = this.segVtx;
    for (let r = 0; r < SEG_ROWS; r++) {
      const t = SEG_ROWS > 1 ? r / (SEG_ROWS - 1) : 0;
      const yn = lo + (hi - lo) * t;
      const rad = this.sampleRadius(samples, yn) * radiusScale + SEG_LIFT_CM;
      const y = yn * height;
      v[1] = y; v[2] = 0; v[3] = 0; v[4] = 0; v[5] = 1; v[7] = t;
      v[0] = rad; v[6] = 0;
      this.segBuilder.setVertexInterleaved(r * 2, v);
      // A flat ribbon standing in the profile plane, a little wider than the
      // leader so it reads as a band on the form rather than another line.
      v[0] = rad + SEG_BAND_CM; v[6] = 1;
      this.segBuilder.setVertexInterleaved(r * 2 + 1, v);
    }
    if (this.segBuilder.isValid()) this.segBuilder.updateMesh();
    if (this.segMat) {
      this.segMat.mainPass.baseColor = new vec4(1.0, 0.82, 0.25, 1.0);
    }
  }

  /** Profile radius at a normalised height, from the resampled curve. */
  private sampleRadius(samples: ProfilePoint[], yn: number): number {
    const n = samples.length;
    if (n === 0) return 0;
    if (yn <= samples[0].y) return samples[0].r;
    if (yn >= samples[n - 1].y) return samples[n - 1].r;
    for (let i = 1; i < n; i++) {
      if (yn <= samples[i].y) {
        const span = samples[i].y - samples[i - 1].y;
        const k = span > 1e-6 ? (yn - samples[i - 1].y) / span : 0;
        return samples[i - 1].r + (samples[i].r - samples[i - 1].r) * k;
      }
    }
    return samples[n - 1].r;
  }

  private dragHandle(h: Handle): void {
    const world = this.interactorPoint(h.activeInteractor, h);
    if (!world) {
      return;
    }

    const height = this.mesher.height;
    const radiusScale = this.mesher.radiusScale;
    if (height <= 0 || radiusScale <= 0) {
      if (!this.warned) {
        this.warned = true;
        print("ProfileHandles: mesher height/radiusScale must be > 0.");
      }
      return;
    }

    // Delta in the lathe's own space: local X is radius, local Y is height.
    const local = this.toLocal(world);
    const k = this.dragSensitivity > 0 ? this.dragSensitivity : 1;
    const dx = (local.x - h.grabLocal.x) * k;
    const dy = (local.y - h.grabLocal.y) * k;

    let r = h.grabR + dx / radiusScale;
    r = r < MIN_RADIUS ? MIN_RADIUS : r > MAX_RADIUS ? MAX_RADIUS : r;

    const pts = this.model.getPoints();
    const lower = h.index > 0 ? pts[h.index - 1].y + MIN_Y_GAP : 0;
    const upper = h.index < CONTROL_POINTS - 1 ? pts[h.index + 1].y - MIN_Y_GAP : 1;

    let y = h.grabY + dy / height;
    if (y < lower) {
      y = lower;
    }
    if (y > upper) {
      y = upper;
    }
    // A collapsed bracket (neighbours closer than the gap) would invert.
    if (upper < lower) {
      y = h.grabY;
    }

    // Fires onChanged -> LatheMesher marks dirty -> it rebuilds this frame.
    this.model.setPoint(h.index, y, r);
  }

  private updateAppearance(h: Handle): void {
    const target = h.hovered || h.held ? this.hoverScale : 1;
    // Frame-rate independent ease toward the target.
    const k = Math.min(1, getDeltaTime() * 14);
    h.scaleMul += (target - h.scaleMul) * k;

    const s = this.handleRadius * h.scaleMul;
    h.transform.setLocalScale(new vec3(s, s, s));

    // Brighten on hover. Both colors stay bright and saturated: on the
    // waveguide display black renders as transparent, so dark values vanish.
    const lift = h.scaleMul - 1;
    const t = this.hoverScale > 1 ? lift / (this.hoverScale - 1) : 0;
    // Hover reads on BOTH channels at once - it grows and it lights up - so it
    // is unmistakable at a glance even when the grip is small in the frame.
    h.material.mainPass.baseColor = new vec4(
      0.05 + 0.95 * t,
      0.80 + 0.20 * t,
      1.0,
      1.0
    );
  }

  private layoutHandles(): void {
    if (this.handles.length === 0) {
      return;
    }
    const pts = this.model.getPoints();
    const height = this.mesher.height;
    const radiusScale = this.mesher.radiusScale;

    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i];
      // Floating on the +X side, in the lathe's own XY profile plane. The
      // offset lifts the handle clear of the surface; it is a constant, so it
      // cancels out of the drag delta and does not bias the radius mapping.
      h.transform.setLocalPosition(
        new vec3(pts[i].r * radiusScale + this.handleOffset, pts[i].y * height, 0)
      );
    }
  }
}
