/**
 * WHEEL - ProfileModel
 *
 * Plain data model (NOT a BaseScriptComponent). Holds 8 normalized control
 * points describing the silhouette of a lathed form, and resamples them
 * through a uniform Catmull-Rom spline into PROFILE_SAMPLES points.
 *
 * Zero dependencies: no SIK, no UIKit, no packages.
 */

/** Number of resampled points handed to the mesher. */
export const PROFILE_SAMPLES = 48;

/** Number of user-editable control points. */
export const CONTROL_POINTS = 8;

/** A single profile point: height and radius, both normalized 0..1. */
export interface ProfilePoint {
  y: number;
  r: number;
}

/**
 * Minimal callback list. Deliberately local to this file so the core modules
 * stay package-free (no SIK Event import).
 */
export class ChangedEvent {
  private callbacks: (() => void)[] = [];

  add(cb: () => void): void {
    if (cb && this.callbacks.indexOf(cb) === -1) {
      this.callbacks.push(cb);
    }
  }

  remove(cb: () => void): void {
    const i = this.callbacks.indexOf(cb);
    if (i !== -1) {
      this.callbacks.splice(i, 1);
    }
  }

  /** Invoke over a copy so a listener may unsubscribe from inside its own callback. */
  invoke(): void {
    const snapshot = this.callbacks.slice();
    for (let i = 0; i < snapshot.length; i++) {
      snapshot[i]();
    }
  }
}

function clamp01(v: number): number {
  if (!isFinite(v)) {
    return 0;
  }
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Hardcoded vase-like default: narrow foot, lower-middle bulge, waist, flared
 * rim. Module scope so resetToDefaults() and the constructor share one source.
 */
const DEFAULT_PROFILE: ProfilePoint[] = [
  {y: 0.0, r: 0.3},
  {y: 0.1, r: 0.46},
  {y: 0.28, r: 0.86},
  {y: 0.45, r: 0.78},
  {y: 0.62, r: 0.42},
  {y: 0.78, r: 0.37},
  {y: 0.9, r: 0.54},
  {y: 1.0, r: 0.8}
];

export class ProfileModel {
  readonly onChanged = new ChangedEvent();

  private points: ProfilePoint[] = [];

  /**
   * Cached resample output. The SAME array instance is returned from
   * getSamples() on every call and its member objects are mutated in place,
   * because this is read once per mesh rebuild (potentially every frame).
   */
  private samples: ProfilePoint[] = [];
  private dirty = true;

  constructor() {
    for (let i = 0; i < CONTROL_POINTS; i++) {
      this.points.push({y: DEFAULT_PROFILE[i].y, r: DEFAULT_PROFILE[i].r});
    }
    this.sortPoints();

    for (let i = 0; i < PROFILE_SAMPLES; i++) {
      this.samples.push({y: 0, r: 0});
    }
  }

  /** Read access to the 8 control points (live objects - treat as read-only). */
  getPoints(): ProfilePoint[] {
    return this.points;
  }

  /**
   * Move a control point. Values are clamped to 0..1, the index is
   * bounds-checked (out-of-range calls are ignored), and the list is kept
   * sorted ascending by y.
   */
  setPoint(index: number, y: number, r: number): void {
    if (index < 0 || index >= this.points.length || !isFinite(index)) {
      return;
    }
    const p = this.points[index | 0];
    p.y = clamp01(y);
    p.r = clamp01(r);
    this.sortPoints();
    this.dirty = true;
    this.onChanged.invoke();
  }

  /**
   * Resampled profile, bottom -> top. Recomputed lazily only when dirty and
   * always returned as the same cached array instance.
   */
  getSamples(): ProfilePoint[] {
    if (this.dirty) {
      this.resample();
      this.dirty = false;
    }
    return this.samples;
  }

  /** JSON of the 8 control points. */
  serialize(): string {
    return JSON.stringify(this.points);
  }

  /**
   * Restore from serialize() output. Malformed input leaves the model
   * untouched and fires nothing.
   */
  deserialize(s: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      return;
    }

    if (!Array.isArray(parsed) || parsed.length !== CONTROL_POINTS) {
      return;
    }

    const staged: ProfilePoint[] = [];
    for (let i = 0; i < CONTROL_POINTS; i++) {
      const raw = parsed[i] as {y?: unknown; r?: unknown} | null;
      if (!raw || typeof raw !== "object") {
        return;
      }
      const y = raw.y;
      const r = raw.r;
      if (typeof y !== "number" || typeof r !== "number") {
        return;
      }
      if (!isFinite(y) || !isFinite(r)) {
        return;
      }
      staged.push({y: clamp01(y), r: clamp01(r)});
    }

    // Only commit once the whole payload has validated.
    for (let i = 0; i < CONTROL_POINTS; i++) {
      this.points[i].y = staged[i].y;
      this.points[i].r = staged[i].r;
    }
    this.sortPoints();
    this.dirty = true;
    this.onChanged.invoke();
  }

  /** Restore the starting silhouette. Fires onChanged like any other edit. */
  resetToDefaults(): void {
    for (let i = 0; i < CONTROL_POINTS; i++) {
      this.points[i].y = DEFAULT_PROFILE[i].y;
      this.points[i].r = DEFAULT_PROFILE[i].r;
    }
    this.sortPoints();
    this.dirty = true;
    this.onChanged.invoke();
  }

  /** Force a resample on the next getSamples() call. */
  markDirty(): void {
    this.dirty = true;
  }

  private sortPoints(): void {
    this.points.sort((a, b) => a.y - b.y);
  }

  /**
   * Uniform (index-parameterized) Catmull-Rom through all 8 control points.
   * Endpoints use extrapolated phantom neighbours rather than duplicated
   * endpoints, which preserves the incoming/outgoing tangent instead of
   * flattening the curve at the base and rim.
   */
  private resample(): void {
    const pts = this.points;
    const n = pts.length;
    const segments = n - 1;

    // Phantom control points: p[-1] = 2*p[0] - p[1], p[n] = 2*p[n-1] - p[n-2].
    const beforeY = 2 * pts[0].y - pts[1].y;
    const beforeR = 2 * pts[0].r - pts[1].r;
    const afterY = 2 * pts[n - 1].y - pts[n - 2].y;
    const afterR = 2 * pts[n - 1].r - pts[n - 2].r;

    for (let s = 0; s < PROFILE_SAMPLES; s++) {
      // Global parameter across [0, segments].
      const u = (s / (PROFILE_SAMPLES - 1)) * segments;
      let seg = Math.floor(u);
      if (seg > segments - 1) {
        seg = segments - 1;
      }
      if (seg < 0) {
        seg = 0;
      }
      const t = u - seg;

      const i0 = seg - 1;
      const i1 = seg;
      const i2 = seg + 1;
      const i3 = seg + 2;

      const p0y = i0 < 0 ? beforeY : pts[i0].y;
      const p0r = i0 < 0 ? beforeR : pts[i0].r;
      const p1y = pts[i1].y;
      const p1r = pts[i1].r;
      const p2y = pts[i2].y;
      const p2r = pts[i2].r;
      const p3y = i3 > n - 1 ? afterY : pts[i3].y;
      const p3r = i3 > n - 1 ? afterR : pts[i3].r;

      const t2 = t * t;
      const t3 = t2 * t;

      let y =
        0.5 *
        (2 * p1y +
          (-p0y + p2y) * t +
          (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 +
          (-p0y + 3 * p1y - 3 * p2y + p3y) * t3);

      let r =
        0.5 *
        (2 * p1r +
          (-p0r + p2r) * t +
          (2 * p0r - 5 * p1r + 4 * p2r - p3r) * t2 +
          (-p0r + 3 * p1r - 3 * p2r + p3r) * t3);

      // A negative radius flips the surface inside out; a y outside 0..1
      // would push geometry past the authored height.
      if (!isFinite(y)) {
        y = 0;
      }
      if (!isFinite(r)) {
        r = 0;
      }
      const out = this.samples[s];
      out.y = y < 0 ? 0 : y > 1 ? 1 : y;
      out.r = r < 0 ? 0 : r;
    }
  }
}
