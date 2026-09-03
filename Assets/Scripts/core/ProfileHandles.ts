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
const GRAB_RADIUS_LOCAL = 1.35;

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

  // Grab bookkeeping, valid only while held.
  activeInteractor: any = null;
  grabLocal: vec3 = vec3.zero();
  grabY = 0;
  grabR = 0;
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
  @hint("Handle sphere radius in centimetres.")
  handleRadius: number = 0.9;

  @input
  @hint("Scale multiplier applied while a handle is hovered.")
  hoverScale: number = 1.55;

  @input
  @hint("Centimetres to float each handle outward past the surface, so it is grabbable instead of half-buried in the mesh.")
  handleOffset: number = 1.8;

  private mesher: LatheMesher;
  private model: ProfileModel;

  /** Non-spinning parent for the handles. Tracks the lathe's world position. */
  private rig: SceneObject;
  private rigTransform: Transform;
  private readonly undoStack = new ProfileUndoStack();
  private readonly handles: Handle[] = [];
  private heldCount = 0;
  private warned = false;

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

    // Baseline, so the first undo returns to the starting silhouette.
    this.undoStack.push(this.model.serialize());

    // Any change to the model (drag, undo, external edit) repositions handles.
    this.model.onChanged.add(() => {
      this.layoutHandles();
    });
  }

  // ---------------------------------------------------------------- public

  /** True while at least one handle is pinched. Spin polls this indirectly. */
  isAnyHeld(): boolean {
    return this.heldCount > 0;
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

      this.handles.push(h);
    }

    // SIK events bind in OnStartEvent only. buildHandles() is already called
    // from OnStartEvent, so binding inline here is correct.
    for (let i = 0; i < this.handles.length; i++) {
      this.bindHandle(this.handles[i]);
    }
  }

  private bindHandle(h: Handle): void {
    h.interactable.onHoverEnter.add(() => {
      h.hovered = true;
    });
    h.interactable.onHoverExit.add(() => {
      h.hovered = false;
    });

    h.interactable.onTriggerStart.add((e: InteractorEvent) => {
      this.beginDrag(h, e);
    });

    const end = (e: InteractorEvent) => {
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
  private interactorPoint(io: any): vec3 {
    if (!io) {
      return null;
    }
    if (io.startPoint) {
      return io.startPoint;
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
  private syncRig(): void {
    const lathe = this.sceneObject.getTransform();
    this.rigTransform.setWorldPosition(lathe.getWorldPosition());
    this.rigTransform.setWorldRotation(quat.quatIdentity());
  }

  private beginDrag(h: Handle, e: InteractorEvent): void {
    if (h.held) {
      return;
    }
    const world = this.interactorPoint(e.interactor);
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

    // Cheap no-op while the vessel stays put; keeps the handles attached if it
    // is ever repositioned.
    this.syncRig();

    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i];
      if (h.held) {
        this.dragHandle(h);
      }
      this.updateAppearance(h);
    }
  }

  private dragHandle(h: Handle): void {
    const world = this.interactorPoint(h.activeInteractor);
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
    const dx = local.x - h.grabLocal.x;
    const dy = local.y - h.grabLocal.y;

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
    h.material.mainPass.baseColor = new vec4(
      0.0 + 0.75 * t,
      0.85 + 0.15 * t,
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
