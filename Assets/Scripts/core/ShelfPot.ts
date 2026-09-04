/**
 * WHEEL - ShelfPot
 *
 * One miniature pot on the shelf: a real lathe of the stored profile, not an
 * icon standing in for it. The shelf exists so the potter can recognise their
 * own work at a glance, and a row of identical swatches would not let them.
 *
 * Built from the LOW LOD (16 radial) and the same writeLatheVertices() the
 * wheel uses, so a thumbnail is the same surface of revolution the kiln fired,
 * only smaller. Six of these cost ~5k vertices in total.
 *
 * Each pot clones the glaze material so its own recipe is independent - a
 * shared material would repaint every pot on the shelf the colour of the last
 * one drawn.
 */

import {LatheLod, writeLatheVertices} from "./LatheMesher";
import {PROFILE_SAMPLES, ProfileModel} from "./ProfileModel";
import {applyGlazeToPass} from "./GlazeApply";
import type {ShelfPiece} from "./ShelfStore";

const THUMB_RADIAL = 16;

export class ShelfPot {
  readonly root: SceneObject;
  private readonly lod: LatheLod;
  private readonly model = new ProfileModel();
  private readonly mat: Material;
  private readonly visual: RenderMeshVisual;

  /**
   * @param heightCm Height of the miniature. The stored profile is normalised,
   *   so this alone sets the scale; radius follows at the same ratio the full
   *   pot uses (7 : 22) to keep the proportions honest.
   */
  constructor(parent: SceneObject, glazeMaterial: Material,
      private readonly heightCm: number) {
    this.root = global.scene.createSceneObject("ShelfPot");
    this.root.setParent(parent);

    this.lod = new LatheLod(THUMB_RADIAL, PROFILE_SAMPLES);
    this.visual = this.root.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    this.visual.mesh = this.lod.mesh;

    this.mat = glazeMaterial ? glazeMaterial.clone() : null;
    if (this.mat) {
      this.visual.clearMaterials();
      this.visual.addMaterial(this.mat);
    }
  }

  /** Rebuild this thumbnail to show `piece`. */
  setPiece(piece: ShelfPiece): void {
    this.model.deserialize(piece.profileBytes);
    writeLatheVertices(this.lod, this.model.getSamples(), {
      height: this.heightCm,
      radiusScale: this.heightCm * (7.0 / 22.0),
      // Twist and fluting are wheel-time controls that were already baked into
      // the profile before firing; re-applying them here would double them.
      twist: 0,
      fluteDepth: 0,
      fluteCount: 0
    });
    if (this.mat) {
      // A shelf pot is always fired, so it carries the glow. 0.35 rather than
      // full: six glowing pots in a row would wash each other out.
      applyGlazeToPass(this.mat.mainPass, piece.glazeParams, 0.35);
    }
  }

  set enabled(on: boolean) { this.root.enabled = on; }
}
