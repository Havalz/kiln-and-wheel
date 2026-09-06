/**
 * WHEEL - KilnHeatRings
 *
 * The firing, drawn as fire rather than as geometry. Rings of light climb the
 * pot and a bloom pools around its foot; both are swarms of soft additive
 * sprites, never solid bands. An earlier build drew each ring as a mesh tube
 * standing 2.4cm proud of the vessel, which read as an orange collar bolted
 * onto the pot - hard silhouette edges, wider than the form. Nothing here draws
 * an edge: every sprite is a radial gradient that reaches exactly zero at its
 * rim, so the only shape the eye can find is the shape the swarm makes.
 *
 * WHY SPRITES BUILT FROM MESHES, NOT A VFX GRAPH. Mesh geometry survives into a
 * preview capture; the VFX particle pass does not. An effect I cannot see is an
 * effect I cannot verify, and this one has to be checked from two angles.
 *
 * BRIGHTNESS IS QUANTISED, NOT PER-VERTEX. The unlit shader exposes no vertex
 * colour, so a sprite's brightness can only come from its material. Rather than
 * one material per particle - hundreds of draw calls - particles are sorted
 * each frame into BUCKETS brightness levels, one mesh and one material each.
 * Six levels is finer than the eye tracks on a flickering ember, and the whole
 * effect costs six draw calls. Hue rides the same axis: dim buckets are deep
 * ember, bright buckets run to hot yellow-white, the way real flame does.
 *
 * ONE CURVE. Ring cadence, ring brightness, bloom spawn rate, bloom radius and
 * sprite scale all read KilnStation.getHeat(). Lifetimes are clipped to the
 * time left in the sequence, so nothing finishes before the audio does.
 */

import {KilnStation} from "./KilnStation";
import {LatheMesher} from "./core/LatheMesher";
import type {ProfilePoint} from "./core/ProfileModel";

/** Brightness levels. Each costs one mesh, one material and one draw call. */
const BUCKETS = 6;
/** Quads each bucket mesh can hold. Must exceed the whole particle budget. */
const POOL = 340;
const VERT_STRIDE = 8;

// ── Climbing rings ──────────────────────────────────────────────────────────
const RING_MAX = 6;
const RING_PARTICLES = 34;
const RING_LIFE = 1.9;
const SPAWN_MIN = 0.34;
const SPAWN_MAX = 0.55;
/** How far past the rim a ring climbs before it is gone. */
const RING_OVERSHOOT = 1.06;
/** Radians per second a ring turns as it climbs. */
const RING_SPIN = 0.55;
/**
 * Scatter around the ideal ring, in cm, signed. Without it the ring is a
 * perfect circle of dots, which reads as a machine part rather than as flame.
 */
const RING_RADIUS_JITTER = 0.9;
const RING_HEIGHT_JITTER = 1.5;
/**
 * Sprites sit a hair outside the glaze - not floating off it. Half a centimetre
 * on a seven-centimetre radius is invisible as an offset but enough that the
 * near arc is not clipped by the surface it is lying on, while the far arc is
 * still occluded by the pot. That occlusion is what makes the ring read as
 * wrapping the vessel instead of being painted over it.
 */
const RING_SURFACE_LIFT = 0.5;
const RING_SPRITE_CM = 3.2;

// ── Base bloom ──────────────────────────────────────────────────────────────
const BLOOM_MAX = 120;
/** Particles per second at full heat. */
const BLOOM_RATE = 72;
const BLOOM_LIFE_MIN = 0.85;
const BLOOM_LIFE_MAX = 1.45;
const BLOOM_RISE_MIN = 7;
const BLOOM_RISE_MAX = 18;
/**
 * Lateral drift is RADIAL and zero-mean: every particle drifts along its own
 * spawn bearing, so the cloud opens evenly in all directions. There is no
 * constant velocity term anywhere in this file - a single shared vector is what
 * turns a bloom into a plume blowing off to one side.
 */
const BLOOM_DRIFT_MAX = 3.2;
const BLOOM_WANDER = 1.1;
const BLOOM_SPRITE_CM = 4.2;
const FOOT_LIFT = 0.4;

/**
 * Brightness multiplier per bucket. Above 1 on purpose: additive blending
 * clamps at white, so overdriving the bright buckets produces a hot core with
 * a coloured falloff instead of a uniformly translucent orange wash.
 */
const BUCKET_GAIN = 4.0;

const TWO_PI = Math.PI * 2;

function rand(): number { return Math.random(); }
function signed(): number { return Math.random() * 2 - 1; }
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smoothstep(v: number): number { const t = clamp01(v); return t * t * (3 - 2 * t); }

/** One soft sprite. Ring particles ride their ring; bloom particles fly free. */
class Particle {
  alive = false;
  ring = -1;          // index into rings, or -1 for a bloom particle
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  age = 0; life = 1;
  size = 1;
  angle = 0;
  radJit = 0;
  hJit = 0;
  flickPhase = 0;
  flickRate = 1;
}

class Ring {
  active = false;
  age = 0;
  life = RING_LIFE;
  spin = 0;
  seed = 0;
}

class Bucket {
  root: SceneObject = null;
  visual: RenderMeshVisual = null;
  mat: Material = null;
  builder: MeshBuilder = null;
  used = 0;
  prevUsed = 0;
}

@component
export class KilnHeatRings extends BaseScriptComponent {
  @ui.label("Heat rings — the firing, shown as fire climbing the form")
  @ui.separator

  @input @hint("Supplies the silhouette the rings hug, plus height and radius scale.")
  mesher: LatheMesher;

  @input @hint("Supplies the one shared heat curve.")
  kiln: KilnStation;

  @input @hint("Billboards face this. Wire the same Camera Object the placement probe uses.")
  camera: SceneObject;

  @input
  @allowUndefined
  @hint("Unlit ADDITIVE material with ENABLE_BASE_TEX on. Without it the swarm is built but never drawn.")
  spriteMaterial: Material;

  @input
  @hint("Colour of the dimmest embers.")
  @widget(new ColorWidget())
  emberColor: vec4 = new vec4(1.0, 0.30, 0.04, 1.0);

  @input
  @hint("Colour at peak brightness. Hotter reads whiter, so this runs to yellow-white.")
  @widget(new ColorWidget())
  hotColor: vec4 = new vec4(1.0, 0.86, 0.55, 1.0);

  private buckets: Bucket[] = [];
  private parts: Particle[] = [];
  private rings: Ring[] = [];
  private swarmRoot: SceneObject = null;
  private nextSpawn = 0;
  private bloomDebt = 0;
  private wasFiring = false;
  private clock = 0;
  private dbg = 0;
  private camRight = new vec3(1, 0, 0);
  private camUp = new vec3(0, 1, 0);
  private camFwd = new vec3(0, 0, 1);
  private readonly vtx: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  private readonly zeroVtx: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.mesher || !this.kiln) {
      print("[Rings] mesher or kiln not assigned - the swarm is inert.");
      return;
    }

    // The swarm lives on its own root at the wheel's position, NOT parented to
    // the lathe: the lathe spins, and fire that spins with the clay it is
    // heating looks like a decal. Identity rotation also means camera axes can
    // be used for billboarding without transforming into a rotating space.
    this.swarmRoot = global.scene.createSceneObject("HeatSwarm");
    this.swarmRoot.getTransform().setWorldPosition(
      this.mesher.sceneObject.getTransform().getWorldPosition());

    const sprite = this.makeSprite(64);
    for (let b = 0; b < BUCKETS; b++) this.buckets.push(this.buildBucket(b, sprite));
    for (let i = 0; i < POOL; i++) this.parts.push(new Particle());
    for (let i = 0; i < RING_MAX; i++) this.rings.push(new Ring());

    print("[Rings] swarm ready: " + BUCKETS + " buckets x " + POOL + " sprites.");
  }

  /**
   * A radial gradient that reaches exactly zero at its rim. This is the whole
   * reason the effect has no visible edges - the geometry is a quad, but the
   * quad's corners contribute nothing, so what is drawn is a soft round glow.
   */
  private makeSprite(px: number): Texture {
    const tex = ProceduralTextureProvider.create(px, px, Colorspace.RGBA);
    const provider = tex.control as ProceduralTextureProvider;
    const data = new Uint8Array(px * px * 4);
    const c = (px - 1) / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = (x - c) / c;
        const dy = (y - c) / c;
        const d = Math.sqrt(dx * dx + dy * dy);
        let f = smoothstep(1 - d);
        f = f * f;                       // tighten to a hot core with a long tail
        const v = Math.round(f * 255);
        const i = (y * px + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = v;
      }
    }
    provider.setPixels(0, 0, px, px, data);
    return tex;
  }

  /** Allocate-once, exactly like the lathe: vertices are rewritten, never re-appended. */
  private buildBucket(index: number, sprite: Texture): Bucket {
    const k = new Bucket();
    k.root = global.scene.createSceneObject("HeatSwarm_" + index);
    k.root.setParent(this.swarmRoot);
    k.root.layer = this.mesher.sceneObject.layer;

    k.builder = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    k.builder.topology = MeshTopology.Triangles;
    k.builder.indexType = MeshIndexType.UInt16;

    const zeros: number[] = new Array(POOL * 4 * VERT_STRIDE);
    for (let i = 0; i < zeros.length; i++) zeros[i] = 0;
    k.builder.appendVerticesInterleaved(zeros);

    const idx: number[] = [];
    for (let q = 0; q < POOL; q++) {
      const b = q * 4;
      idx.push(b, b + 1, b + 2);
      idx.push(b + 2, b + 1, b + 3);
    }
    k.builder.appendIndices(idx);
    // Take the mesh handle straight after appending, exactly as LatheLod does.
    k.visual = k.root.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    k.visual.mesh = k.builder.getMesh();

    if (this.spriteMaterial) {
      k.mat = this.spriteMaterial.clone();
      const pass = k.mat.mainPass as any;
      pass.baseTex = sprite;
      // Level runs from the middle of the dimmest bucket to the middle of the
      // brightest, so no bucket is fully black and none clips.
      const level = (index + 0.5) / BUCKETS;
      const g = level * BUCKET_GAIN;
      const e = this.emberColor;
      const h = this.hotColor;
      pass.baseColor = new vec4(
        (e.x + (h.x - e.x) * level) * g,
        (e.y + (h.y - e.y) * level) * g,
        (e.z + (h.z - e.z) * level) * g,
        level);
      k.visual.clearMaterials();
      k.visual.addMaterial(k.mat);
    }
    return k;
  }

  // ── Silhouette ────────────────────────────────────────────────────────────

  /**
   * The profile's radius at a normalised height. This is what keeps a ring ON
   * the pot: it swells at the belly and pinches at the neck because it is
   * reading the same samples the lathe extrudes.
   */
  private radiusAt(h: number): number {
    const s: ProfilePoint[] = this.mesher.getModel().getSamples();
    const n = s.length;
    if (n === 0) return 0;
    if (h <= s[0].y) return s[0].r;
    if (h >= s[n - 1].y) return s[n - 1].r;
    for (let i = 1; i < n; i++) {
      if (h <= s[i].y) {
        const span = s[i].y - s[i - 1].y;
        const k = span > 1e-6 ? (h - s[i - 1].y) / span : 0;
        return s[i - 1].r + (s[i].r - s[i - 1].r) * k;
      }
    }
    return s[n - 1].r;
  }

  // ── Frame ─────────────────────────────────────────────────────────────────

  private onUpdate(): void {
    if (this.buckets.length === 0) return;

    const dt = getDeltaTime();
    this.clock += dt;

    const heat = this.kiln.getHeat();
    const firing = heat > 0.001;
    if (firing && !this.wasFiring) { this.nextSpawn = 0; this.bloomDebt = 0; }
    this.wasFiring = firing;

    this.readCamera();

    const remaining = Math.max(0, this.kiln.getDuration() - this.kiln.getElapsed());
    if (firing) {
      this.nextSpawn -= dt;
      if (this.nextSpawn <= 0) {
        this.spawnRing(remaining);
        this.nextSpawn = SPAWN_MAX - (SPAWN_MAX - SPAWN_MIN) * heat;
      }
      this.bloomDebt += BLOOM_RATE * heat * dt;
      while (this.bloomDebt >= 1) {
        this.bloomDebt -= 1;
        this.spawnBloom(heat, remaining);
      }
    }

    this.advanceRings(dt);
    this.emit(heat, dt);
  }

  private readCamera(): void {
    if (!this.camera) return;
    const rot = this.camera.getTransform().getWorldRotation();
    this.camRight = rot.multiplyVec3(new vec3(1, 0, 0));
    this.camUp = rot.multiplyVec3(new vec3(0, 1, 0));
    this.camFwd = rot.multiplyVec3(new vec3(0, 0, -1));
  }

  // ── Spawning ──────────────────────────────────────────────────────────────

  private spawnRing(remaining: number): void {
    if (remaining <= 0.05) return;
    let slot = -1;
    for (let i = 0; i < this.rings.length; i++) {
      if (!this.rings[i].active) { slot = i; break; }
    }
    if (slot < 0) return;

    const r = this.rings[slot];
    r.active = true;
    r.age = 0;
    // NOTHING FINISHES EARLY: a ring spawned late gets exactly the time left,
    // so the last one dissolves as the roar resolves rather than before it.
    r.life = Math.min(RING_LIFE, remaining);
    r.spin = (rand() * 0.6 + 0.7) * RING_SPIN;
    r.seed = rand() * TWO_PI;

    for (let i = 0; i < RING_PARTICLES; i++) {
      const p = this.take();
      if (!p) return;
      p.ring = slot;
      // Even spacing plus scatter: the eye reads a ring, never a polygon.
      p.angle = (i / RING_PARTICLES) * TWO_PI + signed() * 0.10;
      p.radJit = signed() * RING_RADIUS_JITTER;
      p.hJit = signed() * RING_HEIGHT_JITTER;
      p.size = RING_SPRITE_CM * (0.62 + rand() * 0.76);
      p.flickPhase = rand() * TWO_PI;
      p.flickRate = 6 + rand() * 9;
      p.age = 0;
      p.life = r.life;
    }
  }

  private spawnBloom(heat: number, remaining: number): void {
    if (remaining <= 0.05) return;
    let live = 0;
    for (let i = 0; i < this.parts.length; i++) {
      if (this.parts[i].alive && this.parts[i].ring < 0) live++;
    }
    if (live >= BLOOM_MAX) return;

    const p = this.take();
    if (!p) return;

    // Even over the full 360 degrees, at the foot's own radius.
    const a = rand() * TWO_PI;
    const footR = this.radiusAt(0.02) * this.mesher.radiusScale;
    const spread = 0.72 + 0.5 * heat;
    const rad = footR * spread * (0.82 + rand() * 0.36);
    const drift = rand() * BLOOM_DRIFT_MAX;

    p.ring = -1;
    p.angle = a;
    p.x = Math.cos(a) * rad;
    p.z = Math.sin(a) * rad;
    p.y = FOOT_LIFT + rand() * 1.4;
    // Radial drift plus zero-mean wander. No shared direction term exists.
    p.vx = Math.cos(a) * drift + signed() * BLOOM_WANDER;
    p.vz = Math.sin(a) * drift + signed() * BLOOM_WANDER;
    p.vy = BLOOM_RISE_MIN + rand() * (BLOOM_RISE_MAX - BLOOM_RISE_MIN);
    p.size = BLOOM_SPRITE_CM * (0.6 + rand() * 0.8);
    p.flickPhase = rand() * TWO_PI;
    p.flickRate = 5 + rand() * 8;
    p.age = 0;
    p.life = Math.min(BLOOM_LIFE_MIN + rand() * (BLOOM_LIFE_MAX - BLOOM_LIFE_MIN), remaining);
  }

  private take(): Particle {
    for (let i = 0; i < this.parts.length; i++) {
      if (!this.parts[i].alive) { this.parts[i].alive = true; return this.parts[i]; }
    }
    return null;
  }

  private advanceRings(dt: number): void {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      if (!r.active) continue;
      r.age += dt;
      if (r.age >= r.life) r.active = false;
    }
  }

  // ── Emit ──────────────────────────────────────────────────────────────────

  private emit(heat: number, dt: number): void {
    for (let b = 0; b < this.buckets.length; b++) this.buckets[b].used = 0;

    const height = this.mesher.height;
    const radiusScale = this.mesher.radiusScale;

    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; p.ring = -1; continue; }

      const u = p.age / p.life;
      // Emerge and dissolve; never pop.
      const env = smoothstep(u / 0.20) * smoothstep((1 - u) / 0.38);
      let bright = heat * env;
      let sizeScale = 1;

      if (p.ring >= 0) {
        const r = this.rings[p.ring];
        if (!r.active) { p.alive = false; p.ring = -1; continue; }
        const climb = r.age / r.life;
        const yRing = climb * height * RING_OVERSHOOT;
        const a = p.angle + r.age * r.spin;

        // Sample the profile at the particle's OWN height, not the ring's, so
        // scatter still lands on the surface rather than inside or outside it.
        const hLocal = clamp01((yRing + p.hJit) / height);
        const rad = this.radiusAt(hLocal) * radiusScale + RING_SURFACE_LIFT + p.radJit;
        p.x = Math.cos(a) * rad;
        p.z = Math.sin(a) * rad;
        p.y = yRing + p.hJit;

        // Denser in some arcs than others, and the dense arcs travel: real
        // flame is never evenly distributed around what it is wrapping.
        const arc = 0.55 + 0.45 * Math.abs(Math.sin(a * 1.5 + this.clock * 0.9 + r.seed));
        bright *= arc;
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        // Lateral motion bleeds off so the cloud rises rather than spreading
        // into a disc; vertical motion is left alone.
        p.vx -= p.vx * 1.6 * dt;
        p.vz -= p.vz * 1.6 * dt;
        sizeScale = 0.75 + 0.45 * u;   // embers swell slightly as they cool
      }

      bright *= 0.72 + 0.28 * Math.sin(p.flickPhase + this.clock * p.flickRate);
      if (bright <= 0.02) continue;

      let b = Math.floor(bright * BUCKETS);
      if (b < 0) b = 0;
      if (b >= BUCKETS) b = BUCKETS - 1;
      const k = this.buckets[b];
      if (k.used >= POOL) continue;
      this.writeQuad(k, k.used, p.x, p.y, p.z, p.size * sizeScale * 0.5);
      k.used++;
    }

    this.dbg += dt;
    if (this.dbg > 0.5 && heat > 0.001) {
      this.dbg = 0;
      let ring = 0, bloom = 0;
      for (let i = 0; i < this.parts.length; i++) {
        if (!this.parts[i].alive) continue;
        if (this.parts[i].ring >= 0) ring++; else bloom++;
      }
      let per = "";
      for (let b = 0; b < this.buckets.length; b++) per += this.buckets[b].used + " ";
      print("[Rings] heat=" + heat.toFixed(2) + " t=" + this.kiln.getElapsed().toFixed(2) +
            " ring=" + ring + " bloom=" + bloom + " drawn/bucket=" + per);
    }

    for (let b = 0; b < this.buckets.length; b++) {
      const k = this.buckets[b];
      for (let s = k.used; s < k.prevUsed; s++) this.collapse(k, s);
      if (k.used > 0 || k.prevUsed > 0) {
        if (k.builder.isValid()) k.builder.updateMesh();
      }
      k.prevUsed = k.used;
    }
  }

  /** A camera-facing quad. Corner order matches the index buffer built once above. */
  private writeQuad(k: Bucket, slot: number, cx: number, cy: number, cz: number,
      half: number): void {
    const rx = this.camRight.x * half, ry = this.camRight.y * half, rz = this.camRight.z * half;
    const ux = this.camUp.x * half, uy = this.camUp.y * half, uz = this.camUp.z * half;
    const nx = -this.camFwd.x, ny = -this.camFwd.y, nz = -this.camFwd.z;
    const base = slot * 4;
    const v = this.vtx;
    v[3] = nx; v[4] = ny; v[5] = nz;

    v[0] = cx - rx - ux; v[1] = cy - ry - uy; v[2] = cz - rz - uz; v[6] = 0; v[7] = 0;
    k.builder.setVertexInterleaved(base, v);
    v[0] = cx + rx - ux; v[1] = cy + ry - uy; v[2] = cz + rz - uz; v[6] = 1; v[7] = 0;
    k.builder.setVertexInterleaved(base + 1, v);
    v[0] = cx - rx + ux; v[1] = cy - ry + uy; v[2] = cz - rz + uz; v[6] = 0; v[7] = 1;
    k.builder.setVertexInterleaved(base + 2, v);
    v[0] = cx + rx + ux; v[1] = cy + ry + uy; v[2] = cz + rz + uz; v[6] = 1; v[7] = 1;
    k.builder.setVertexInterleaved(base + 3, v);
  }

  /** Collapse an unused slot to a degenerate point so it rasterizes nothing. */
  private collapse(k: Bucket, slot: number): void {
    const base = slot * 4;
    for (let i = 0; i < 4; i++) k.builder.setVertexInterleaved(base + i, this.zeroVtx);
  }
}
