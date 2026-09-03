/**
 * WHEEL - LatheMesher
 *
 * Revolves a ProfileModel silhouette into a solid of revolution and drives a
 * RenderMeshVisual with it.
 *
 * ALLOCATE-ONCE CONTRACT
 * ----------------------
 * Two independent MeshBuilders are created in onAwake: HIGH (48 radial
 * segments) and LOW (16). They are different topologies, so they cannot share
 * an index buffer. Each builder gets its full vertex buffer appended once and
 * its index buffer appended once, in onAwake, and never again. Every later
 * rebuild is nothing but a loop of setVertexInterleaved() followed by a single
 * updateMesh(). Do not append vertices or indices after onAwake.
 *
 * Zero dependencies: no SIK, no UIKit, no packages. Runs in preview with no
 * device and no hand tracking.
 */

import {PROFILE_SAMPLES, ProfileModel} from "./ProfileModel";

const TWO_PI = Math.PI * 2;

/** position(3) + normal(3) + texture0(2) */
const VERT_STRIDE = 8;

const RADIAL_HIGH = 48;
const RADIAL_LOW = 16;

/**
 * One level of detail: its builder, its pre-built index buffer, and all the
 * scratch buffers a rebuild needs. Everything here is allocated exactly once.
 */
class LatheLod {
  readonly cols: number;
  readonly sideVertexCount: number;
  readonly capCenterIndex: number;
  readonly capRimIndex: number;
  readonly vertexCount: number;

  readonly builder: MeshBuilder;
  readonly mesh: RenderMesh;

  /** Ring-major position cache, length rings * cols. */
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;

  /**
   * Normal accumulators indexed LOGICALLY by ring * radial + (col % radial),
   * so the duplicated seam column shares the accumulator of column 0. Both
   * seam copies then read back the same normal and the crease disappears.
   */
  readonly nrmX: Float32Array;
  readonly nrmY: Float32Array;
  readonly nrmZ: Float32Array;

  /** Reused 8-float scratch for setVertexInterleaved. */
  readonly vtx: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

  /** True when this LOD's vertex data no longer matches the model/params. */
  stale = true;

  readonly radial: number;
  readonly rings: number;

  constructor(radial: number, rings: number) {
    this.radial = radial;
    this.rings = rings;

    // One duplicated seam column so texture0 U can run 0 -> 1 without wrapping.
    this.cols = radial + 1;
    this.sideVertexCount = rings * this.cols;
    this.capCenterIndex = this.sideVertexCount;
    this.capRimIndex = this.sideVertexCount + 1;
    this.vertexCount = this.sideVertexCount + 1 + this.cols;

    this.posX = new Float32Array(this.sideVertexCount);
    this.posY = new Float32Array(this.sideVertexCount);
    this.posZ = new Float32Array(this.sideVertexCount);

    const logicalCount = rings * radial;
    this.nrmX = new Float32Array(logicalCount);
    this.nrmY = new Float32Array(logicalCount);
    this.nrmZ = new Float32Array(logicalCount);

    this.builder = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    this.builder.topology = MeshTopology.Triangles;
    this.builder.indexType = MeshIndexType.UInt16;

    // --- vertex buffer: allocated once, zero-filled, rewritten in place ---
    const zeros: number[] = new Array(this.vertexCount * VERT_STRIDE);
    for (let i = 0; i < zeros.length; i++) {
      zeros[i] = 0;
    }
    this.builder.appendVerticesInterleaved(zeros);

    // --- index buffer: built once ---
    this.builder.appendIndices(this.buildIndices());

    this.mesh = this.builder.getMesh();
  }

  private buildIndices(): number[] {
    const cols = this.cols;
    const rings = this.rings;
    const indices: number[] = [];

    // Sides. Winding chosen so cross(b - a, d - a) points radially outward
    // (counter-clockwise seen from outside the surface).
    for (let ring = 0; ring < rings - 1; ring++) {
      const row0 = ring * cols;
      const row1 = (ring + 1) * cols;
      for (let col = 0; col < cols - 1; col++) {
        const a = row0 + col;
        const b = row1 + col;
        const c = row1 + col + 1;
        const d = row0 + col + 1;
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    // Bottom cap. The builder is MeshTopology.Triangles for the whole mesh,
    // so the fan is emitted as explicit indexed triangles in fan order rather
    // than by switching topology. Order (center, rim[c], rim[c+1]) with c
    // increasing yields a face normal of -Y, i.e. the cap faces DOWN -- the
    // opposite sense to the side quads. Reversing this makes the cap vanish
    // under backface culling.
    const center = this.capCenterIndex;
    const rim = this.capRimIndex;
    for (let col = 0; col < cols - 1; col++) {
      indices.push(center, rim + col, rim + col + 1);
    }

    return indices;
  }
}

@component
export class LatheMesher extends BaseScriptComponent {
  @input
  @allowUndefined
  @hint("Visual whose .mesh is driven by the lathe. Required to see anything.")
  renderMeshVisual: RenderMeshVisual;

  @input
  @hint("Total height of the form, in centimeters.")
  height: number = 22.0;

  @input
  @hint("Centimeters that a normalized profile radius of 1.0 maps to.")
  radiusScale: number = 7.0;

  @input
  @hint("Twist around Y from base to rim, in RADIANS (0 .. 2*PI).")
  twist: number = 0;

  @input
  @hint("Fluting amplitude as a fraction of radius. 0 disables fluting.")
  fluteDepth: number = 0;

  @input
  @hint("Number of flutes around the circumference. Use whole numbers.")
  fluteCount: number = 0;

  private model: ProfileModel;
  private high: LatheLod;
  private low: LatheLod;
  private active: LatheLod;

  private dragging = false;
  private dirty = true;
  private warnedNoVisual = false;

  onAwake(): void {
    this.model = new ProfileModel();

    // Both LODs are constructed here and NEVER re-appended to afterwards.
    this.high = new LatheLod(RADIAL_HIGH, PROFILE_SAMPLES);
    this.low = new LatheLod(RADIAL_LOW, PROFILE_SAMPLES);
    this.active = this.high;

    // The model only raises a flag; the actual rebuild is deferred to the
    // single UpdateEvent below so a burst of edits costs one rebuild, not N.
    this.model.onChanged.add(() => {
      this.invalidate();
    });

    this.createEvent("OnStartEvent").bind(() => {
      this.onStart();
    });

    this.createEvent("UpdateEvent").bind(() => {
      this.onUpdate();
    });
  }

  private onStart(): void {
    this.rebuild(this.active);
    this.applyActiveMesh();
    this.dirty = false;
  }

  private onUpdate(): void {
    if (!this.dirty) {
      return;
    }
    this.rebuild(this.active);
    this.dirty = false;
  }

  // ---------------------------------------------------------------- public

  getModel(): ProfileModel {
    return this.model;
  }

  /**
   * Swap between the 48-segment rest mesh and the 16-segment drag mesh.
   * The inactive LOD is left stale and is rebuilt lazily on the next switch.
   */
  setDragging(dragging: boolean): void {
    if (dragging === this.dragging) {
      return;
    }
    this.dragging = dragging;
    this.active = dragging ? this.low : this.high;

    // The incoming LOD may never have been built at all (its buffer is still
    // the zero-fill from onAwake), so rebuild NOW rather than deferring to the
    // next UpdateEvent -- otherwise the swap shows a collapsed mesh for one
    // frame. If it is not stale it is already current and needs nothing.
    if (this.active.stale) {
      this.rebuild(this.active);
    }
    this.applyActiveMesh();
    this.dirty = false;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  setTwist(radians: number): void {
    if (!isFinite(radians)) {
      return;
    }
    this.twist = radians;
    this.invalidate();
  }

  setFlute(depth: number, count: number): void {
    if (isFinite(depth)) {
      this.fluteDepth = depth;
    }
    if (isFinite(count)) {
      this.fluteCount = count;
    }
    this.invalidate();
  }

  setHeight(cm: number): void {
    if (!isFinite(cm)) {
      return;
    }
    this.height = cm;
    this.invalidate();
  }

  setRadiusScale(cm: number): void {
    if (!isFinite(cm)) {
      return;
    }
    this.radiusScale = cm;
    this.invalidate();
  }

  /** Mark both LODs out of date; the active one rebuilds on the next frame. */
  invalidate(): void {
    this.high.stale = true;
    this.low.stale = true;
    this.dirty = true;
  }

  // --------------------------------------------------------------- private

  private applyActiveMesh(): void {
    if (!this.renderMeshVisual) {
      if (!this.warnedNoVisual) {
        this.warnedNoVisual = true;
        print("LatheMesher: no renderMeshVisual assigned - mesh built but not displayed.");
      }
      return;
    }
    this.renderMeshVisual.mesh = this.active.mesh;
  }

  /**
   * Full vertex rewrite for one LOD. Touches vertices only -- never the index
   * buffer, never the builder allocation.
   */
  private rebuild(lod: LatheLod): void {
    const samples = this.model.getSamples();
    const rings = lod.rings;
    const radial = lod.radial;
    const cols = lod.cols;

    const height = this.height;
    const radiusScale = this.radiusScale;
    const twist = this.twist;
    const fluteDepth = this.fluteDepth;
    const fluteCount = this.fluteCount;

    const posX = lod.posX;
    const posY = lod.posY;
    const posZ = lod.posZ;

    // 1. Positions.
    for (let ring = 0; ring < rings; ring++) {
      const t = ring / (rings - 1);
      const s = samples[ring];
      const y = s.y * height;
      const baseR = s.r * radiusScale;
      const rowBase = ring * cols;
      const twistAtT = twist * t;

      for (let col = 0; col < radial; col++) {
        const angle = (col / radial) * TWO_PI + twistAtT;
        let radius = baseR;
        if (fluteDepth !== 0 && fluteCount !== 0) {
          radius = baseR * (1 + fluteDepth * Math.cos(fluteCount * angle));
          if (radius < 0) {
            radius = 0;
          }
        }
        const vi = rowBase + col;
        posX[vi] = radius * Math.cos(angle);
        posY[vi] = y;
        posZ[vi] = radius * Math.sin(angle);
      }

      // The seam column is an exact copy of column 0 rather than a recomputed
      // angle of 2*PI. With a non-integer fluteCount the flute term does not
      // repeat over a full turn, so recomputing would open a hairline crack.
      const seam = rowBase + radial;
      posX[seam] = posX[rowBase];
      posY[seam] = posY[rowBase];
      posZ[seam] = posZ[rowBase];
    }

    // 2. Reset the normal accumulators (reused, never reallocated).
    const nrmX = lod.nrmX;
    const nrmY = lod.nrmY;
    const nrmZ = lod.nrmZ;
    nrmX.fill(0);
    nrmY.fill(0);
    nrmZ.fill(0);

    // 3. Accumulate un-normalized (area weighted) face normals from the side
    //    quads into the logical buffer. Cap faces are excluded on purpose --
    //    the cap carries its own hard -Y normal.
    for (let ring = 0; ring < rings - 1; ring++) {
      const row0 = ring * cols;
      const row1 = (ring + 1) * cols;
      const nRow0 = ring * radial;
      const nRow1 = (ring + 1) * radial;

      for (let col = 0; col < cols - 1; col++) {
        const a = row0 + col;
        const b = row1 + col;
        const c = row1 + col + 1;
        const d = row0 + col + 1;

        const colL = col % radial;
        const colR = (col + 1) % radial;
        const na = nRow0 + colL;
        const nb = nRow1 + colL;
        const nc = nRow1 + colR;
        const nd = nRow0 + colR;

        // Triangle (a, b, d)
        let e1x = posX[b] - posX[a];
        let e1y = posY[b] - posY[a];
        let e1z = posZ[b] - posZ[a];
        let e2x = posX[d] - posX[a];
        let e2y = posY[d] - posY[a];
        let e2z = posZ[d] - posZ[a];
        let fx = e1y * e2z - e1z * e2y;
        let fy = e1z * e2x - e1x * e2z;
        let fz = e1x * e2y - e1y * e2x;

        nrmX[na] += fx;
        nrmY[na] += fy;
        nrmZ[na] += fz;
        nrmX[nb] += fx;
        nrmY[nb] += fy;
        nrmZ[nb] += fz;
        nrmX[nd] += fx;
        nrmY[nd] += fy;
        nrmZ[nd] += fz;

        // Triangle (b, c, d)
        e1x = posX[c] - posX[b];
        e1y = posY[c] - posY[b];
        e1z = posZ[c] - posZ[b];
        e2x = posX[d] - posX[b];
        e2y = posY[d] - posY[b];
        e2z = posZ[d] - posZ[b];
        fx = e1y * e2z - e1z * e2y;
        fy = e1z * e2x - e1x * e2z;
        fz = e1x * e2y - e1y * e2x;

        nrmX[nb] += fx;
        nrmY[nb] += fy;
        nrmZ[nb] += fz;
        nrmX[nc] += fx;
        nrmY[nc] += fy;
        nrmZ[nc] += fz;
        nrmX[nd] += fx;
        nrmY[nd] += fy;
        nrmZ[nd] += fz;
      }
    }

    // 4. Normalize. A degenerate ring (radius 0, e.g. a closed base point)
    //    accumulates nothing, so fall back to straight up.
    const logicalCount = rings * radial;
    for (let i = 0; i < logicalCount; i++) {
      const x = nrmX[i];
      const y = nrmY[i];
      const z = nrmZ[i];
      const lenSq = x * x + y * y + z * z;
      if (lenSq > 1e-12) {
        const inv = 1 / Math.sqrt(lenSq);
        nrmX[i] = x * inv;
        nrmY[i] = y * inv;
        nrmZ[i] = z * inv;
      } else {
        nrmX[i] = 0;
        nrmY[i] = 1;
        nrmZ[i] = 0;
      }
    }

    // 5. Write side vertices. Both seam copies (col 0 and col == radial) read
    //    the same logical normal, so the shading is continuous across the UV
    //    seam even though the positions are duplicated.
    const builder = lod.builder;
    const v = lod.vtx;
    for (let ring = 0; ring < rings; ring++) {
      const t = ring / (rings - 1);
      const rowBase = ring * cols;
      const nRow = ring * radial;
      for (let col = 0; col < cols; col++) {
        const vi = rowBase + col;
        const ni = nRow + (col % radial);
        v[0] = posX[vi];
        v[1] = posY[vi];
        v[2] = posZ[vi];
        v[3] = nrmX[ni];
        v[4] = nrmY[ni];
        v[5] = nrmZ[ni];
        v[6] = col / radial;
        v[7] = t;
        builder.setVertexInterleaved(vi, v);
      }
    }

    // 6. Cap vertices. Separate copies of ring 0 so the hard -Y normal never
    //    smears into the side shading. Top rim is intentionally left open.
    const baseY = samples[0].y * height;
    v[0] = 0;
    v[1] = baseY;
    v[2] = 0;
    v[3] = 0;
    v[4] = -1;
    v[5] = 0;
    v[6] = 0.5;
    v[7] = 0.5;
    builder.setVertexInterleaved(lod.capCenterIndex, v);

    for (let col = 0; col < cols; col++) {
      const src = col; // ring 0
      const angle = (col / radial) * TWO_PI;
      v[0] = posX[src];
      v[1] = posY[src];
      v[2] = posZ[src];
      v[3] = 0;
      v[4] = -1;
      v[5] = 0;
      v[6] = 0.5 + 0.5 * Math.cos(angle);
      v[7] = 0.5 + 0.5 * Math.sin(angle);
      builder.setVertexInterleaved(lod.capRimIndex + col, v);
    }

    if (!builder.isValid()) {
      print("LatheMesher: mesh data invalid, skipping updateMesh().");
      return;
    }

    builder.updateMesh();
    lod.stale = false;
  }
}
