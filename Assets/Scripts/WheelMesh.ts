/**
 * WheelMesh — procedural wheel built at runtime with MeshBuilder.
 *
 * Geometry is authored with the axle along +Z, so the wheel stands upright in
 * the XY plane and faces the camera. Yaw the SceneObject 90 degrees about Y to
 * turn it into a vehicle wheel rolling along Z.
 *
 * Composition:
 *   tire  — closed lathe profile (rounded sidewalls, flat tread band)
 *   rim   — closed lathe profile with duplicated corners for crisp edges
 *   hub   — open lathe profile, auto-capped, giving a domed centre cap
 *   spokes / tread blocks — Z-rotated boxes
 *
 * All windings are CCW seen from outside, verified by cross product against the
 * outward normal, so the mesh renders under the default Cull Back material.
 */

/** [red, green, blue, alpha] */
type RGBA = [number, number, number, number];

/** A lathe profile point: [radius, axial position along Z]. */
type Pt2 = [number, number];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Revolve a 2D profile around the **Z** axis.
 *
 * The profile is a list of [radius, z] points. Traversing it from -Z to +Z
 * along the outer surface produces outward-facing normals.
 *
 * `closed` treats the profile as a loop (a cross-section outline, e.g. a tyre)
 * and emits no caps. An open profile is capped at each end whose radius is
 * non-zero.
 *
 * Note this is the Z-axis mirror of the usual Y-axis lathe: swapping the
 * profile and angle axes flips the sign of the face normal, so the side-quad
 * and cap windings are reversed relative to a Y lathe.
 */
export function latheZ(
  builder: MeshBuilder,
  indices: number[],
  profile: Pt2[],
  segments: number,
  color: RGBA,
  closed: boolean,
  baseIdx: number,
): number {
  const P = profile.length;
  if (P < 2) return baseIdx;

  const startIdx = baseIdx;
  let vi = baseIdx;

  // Outward 2D normal per profile point. Tangent (dr, dz) -> normal (dz, -dr).
  const n2: Pt2[] = [];
  for (let j = 0; j < P; j++) {
    const prev = closed ? profile[(j - 1 + P) % P] : profile[Math.max(0, j - 1)];
    const next = closed ? profile[(j + 1) % P] : profile[Math.min(P - 1, j + 1)];
    const dr = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dz, dr) || 1;
    n2.push([dz / len, -dr / len]);
  }

  // (segments + 1) rings so the seam ring is duplicated.
  const verts: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (let j = 0; j < P; j++) {
      const r = profile[j][0];
      const z = profile[j][1];
      const nr = n2[j][0];
      const nz = n2[j][1];
      verts.push(
        r * c, r * s, z,
        nr * c, nr * s, nz,
        color[0], color[1], color[2], color[3],
      );
      vi++;
    }
  }
  builder.appendVerticesInterleaved(verts);

  // Side quads. bl/br = profile j and j+1 at angle i, tl/tr = the same pair at
  // angle i+1. This ordering is CCW for a Z-axis lathe.
  const jCount = closed ? P : P - 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < jCount; j++) {
      const jn = (j + 1) % P;
      // Duplicated corners (see sharpLoop) span zero profile distance and would
      // only emit zero-area triangles.
      if (
        Math.abs(profile[j][0] - profile[jn][0]) < 1e-6 &&
        Math.abs(profile[j][1] - profile[jn][1]) < 1e-6
      ) {
        continue;
      }
      const bl = startIdx + i * P + j;
      const br = startIdx + i * P + jn;
      const tl = startIdx + (i + 1) * P + j;
      const tr = startIdx + (i + 1) * P + jn;
      indices.push(bl, tr, br, bl, tl, tr);
    }
  }

  if (closed) return vi;

  // Start cap, normal -Z.
  if (profile[0][0] > 1e-6) {
    const z = profile[0][1];
    const r = profile[0][0];
    const capVerts: number[] = [0, 0, z, 0, 0, -1, color[0], color[1], color[2], color[3]];
    const center = vi;
    vi++;
    const ring = vi;
    for (let i = 0; i <= segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      capVerts.push(
        r * Math.cos(th), r * Math.sin(th), z,
        0, 0, -1,
        color[0], color[1], color[2], color[3],
      );
      vi++;
    }
    builder.appendVerticesInterleaved(capVerts);
    for (let i = 0; i < segments; i++) indices.push(center, ring + i + 1, ring + i);
  }

  // End cap, normal +Z.
  if (profile[P - 1][0] > 1e-6) {
    const z = profile[P - 1][1];
    const r = profile[P - 1][0];
    const capVerts: number[] = [0, 0, z, 0, 0, 1, color[0], color[1], color[2], color[3]];
    const center = vi;
    vi++;
    const ring = vi;
    for (let i = 0; i <= segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      capVerts.push(
        r * Math.cos(th), r * Math.sin(th), z,
        0, 0, 1,
        color[0], color[1], color[2], color[3],
      );
      vi++;
    }
    builder.appendVerticesInterleaved(capVerts);
    for (let i = 0; i < segments; i++) indices.push(center, ring + i, ring + i + 1);
  }

  return vi;
}

/**
 * Duplicate every corner of a closed cross-section so the lathe shades it with
 * crisp edges instead of averaging neighbouring faces into a chamfer.
 * [C0, C1, C2, C3] -> [C0, C1, C1, C2, C2, C3, C3, C0].
 */
export function sharpLoop(corners: Pt2[]): Pt2[] {
  const out: Pt2[] = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    out.push(corners[i]);
    out.push(corners[i]);
  }
  out.push(corners[0]);
  return out;
}

/**
 * A per-face box rotated by `theta` about the Z axis. The centre and half
 * extents are given in the un-rotated frame: +X is radial, +Y tangential.
 * Rotation is orientation preserving, so the verified CCW winding survives it.
 */
export function addBoxRotZ(
  builder: MeshBuilder,
  indices: number[],
  cx: number, cy: number, cz: number,
  hw: number, hh: number, hd: number,
  theta: number,
  color: RGBA,
  baseIdx: number,
): number {
  const ct = Math.cos(theta);
  const st = Math.sin(theta);

  const x0 = cx - hw, x1 = cx + hw;
  const y0 = cy - hh, y1 = cy + hh;
  const z0 = cz - hd, z1 = cz + hd;

  const verts: number[] = [];
  let vi = baseIdx;

  const face = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
    n: [number, number, number],
  ) => {
    const nx = n[0] * ct - n[1] * st;
    const ny = n[0] * st + n[1] * ct;
    const nz = n[2];
    const quad = [p0, p1, p2, p3];
    for (let k = 0; k < 4; k++) {
      const p = quad[k];
      verts.push(
        p[0] * ct - p[1] * st, p[0] * st + p[1] * ct, p[2],
        nx, ny, nz,
        color[0], color[1], color[2], color[3],
      );
    }
    indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  };

  face([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);  // +X
  face([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]); // -X
  face([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]);  // +Y
  face([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]); // -Y
  face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);  // +Z
  face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]); // -Z

  builder.appendVerticesInterleaved(verts);
  return vi;
}

// ---------------------------------------------------------------------------
// Wheel assembly
// ---------------------------------------------------------------------------

export interface WheelParams {
  /** Outer radius of the tyre, in cm. */
  radius: number;
  /** Full width of the tyre along the axle, in cm. */
  width: number;
  spokeCount: number;
  treadBlocks: number;
  /** Angular subdivisions of every lathed part. */
  segments: number;
  tireColor: RGBA;
  treadColor: RGBA;
  rimColor: RGBA;
  spokeColor: RGBA;
  hubColor: RGBA;
}

/** Fills `builder` with a complete wheel centred on the origin, axle along Z. */
export function buildWheel(builder: MeshBuilder, p: WheelParams): void {
  const R = p.radius;
  const hw = p.width * 0.5;
  const seg = Math.max(8, Math.floor(p.segments));

  const bead = R * 0.66;       // tyre inner radius / rim seat
  const rimOuter = bead + R * 0.02;  // overlaps the bead so the seam never z-fights
  const rimInner = R * 0.46;
  const hubR = R * 0.18;

  const indices: number[] = [];
  let vi = 0;

  // --- Tyre: smooth closed cross-section, bulged sidewalls, flat tread band ---
  const sw = R - bead;
  const tire: Pt2[] = [
    [bead, -hw * 0.50],
    [bead + sw * 0.30, -hw * 0.86],
    [bead + sw * 0.62, -hw * 1.00],
    [R - R * 0.06, -hw * 0.88],
    [R, -hw * 0.72],
    [R, hw * 0.72],
    [R - R * 0.06, hw * 0.88],
    [bead + sw * 0.62, hw * 1.00],
    [bead + sw * 0.30, hw * 0.86],
    [bead, hw * 0.50],
  ];
  vi = latheZ(builder, indices, tire, seg, p.tireColor, true, vi);

  // --- Rim barrel: flat annulus band with crisp corners ---
  const rim = sharpLoop([
    [rimInner, -hw * 0.62],
    [rimOuter, -hw * 0.52],
    [rimOuter, hw * 0.52],
    [rimInner, hw * 0.62],
  ]);
  vi = latheZ(builder, indices, rim, seg, p.rimColor, true, vi);

  // --- Hub: open profile, auto-capped into a domed centre cap ---
  const hub: Pt2[] = [
    [hubR, -hw * 0.55],
    [hubR, hw * 0.10],
    [hubR * 0.80, hw * 0.42],
    [hubR * 0.42, hw * 0.58],
  ];
  vi = latheZ(builder, indices, hub, seg, p.hubColor, false, vi);

  // --- Spokes: radial boxes bridging hub and rim ---
  const spokes = Math.max(0, Math.floor(p.spokeCount));
  const sInner = hubR * 0.85;
  const sOuter = rimInner + R * 0.03;
  for (let k = 0; k < spokes; k++) {
    const theta = (k / spokes) * Math.PI * 2;
    vi = addBoxRotZ(
      builder, indices,
      (sInner + sOuter) * 0.5, 0, 0,
      (sOuter - sInner) * 0.5, R * 0.055, hw * 0.30,
      theta, p.spokeColor, vi,
    );
  }

  // --- Tread: two staggered rows of blocks riding the tread band ---
  const blocks = Math.max(0, Math.floor(p.treadBlocks));
  if (blocks > 0) {
    const step = (Math.PI * 2) / blocks;
    const arc = (Math.PI * 2 * R) / blocks;
    for (let row = 0; row < 2; row++) {
      const zc = (row === 0 ? -1 : 1) * hw * 0.36;
      for (let k = 0; k < blocks; k++) {
        const theta = (k + row * 0.5) * step;
        vi = addBoxRotZ(
          builder, indices,
          R - R * 0.005, 0, zc,
          R * 0.022, arc * 0.30, hw * 0.26,
          theta, p.treadColor, vi,
        );
      }
    }
  }

  builder.appendIndices(indices);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@component
export class WheelMesh extends BaseScriptComponent {
  @input
  @hint("Vertex-colour material. Wire vertexBaseColorMaterial here.")
  material: Material;

  @ui.separator
  @ui.label("Dimensions (cm)")

  @input
  @label("Outer Radius")
  radius: number = 35;

  @input
  @label("Width")
  width: number = 18;

  @input
  @label("Spokes")
  spokeCount: number = 6;

  @input
  @label("Tread Blocks")
  treadBlocks: number = 28;

  @input
  @label("Segments")
  @hint("Angular subdivisions. 32-64 is a good range.")
  segments: number = 48;

  @ui.separator
  @ui.label("Colours")

  @input
  @widget(new ColorWidget())
  tireColor: vec4 = new vec4(0.10, 0.10, 0.115, 1);

  @input
  @widget(new ColorWidget())
  treadColor: vec4 = new vec4(0.06, 0.06, 0.07, 1);

  @input
  @widget(new ColorWidget())
  rimColor: vec4 = new vec4(0.74, 0.76, 0.80, 1);

  @input
  @widget(new ColorWidget())
  spokeColor: vec4 = new vec4(0.62, 0.645, 0.68, 1);

  @input
  @widget(new ColorWidget())
  hubColor: vec4 = new vec4(0.30, 0.31, 0.34, 1);

  @ui.separator

  @input
  @label("Spin Speed (deg/sec)")
  @hint("0 leaves the wheel static.")
  spinSpeed: number = 0;

  private spinAngle: number = 0;
  private baseRot: quat = null;

  onAwake(): void {
    const builder = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3, normalized: true },
      { name: "color", components: 4 },
    ]);
    builder.topology = MeshTopology.Triangles;
    builder.indexType = MeshIndexType.UInt16;

    buildWheel(builder, {
      radius: this.radius,
      width: this.width,
      spokeCount: this.spokeCount,
      treadBlocks: this.treadBlocks,
      segments: this.segments,
      tireColor: this.toRGBA(this.tireColor),
      treadColor: this.toRGBA(this.treadColor),
      rimColor: this.toRGBA(this.rimColor),
      spokeColor: this.toRGBA(this.spokeColor),
      hubColor: this.toRGBA(this.hubColor),
    });

    if (!builder.isValid()) {
      print("WheelMesh: MeshBuilder produced invalid mesh data.");
      return;
    }

    const rmv = this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    rmv.mesh = builder.getMesh();
    if (this.material) {
      rmv.mainMaterial = this.material;
    }
    builder.updateMesh();

    if (this.spinSpeed !== 0) {
      this.createEvent("OnStartEvent").bind(() => {
        this.baseRot = this.sceneObject.getTransform().getLocalRotation();
      });
      this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }
  }

  private onUpdate(): void {
    if (!this.baseRot) return;
    this.spinAngle += this.spinSpeed * getDeltaTime();
    const spin = quat.angleAxis((this.spinAngle * Math.PI) / 180, vec3.forward());
    this.sceneObject.getTransform().setLocalRotation(this.baseRot.multiply(spin));
  }

  private toRGBA(c: vec4): RGBA {
    return [c.r, c.g, c.b, c.a];
  }
}
