/**
 * WHEEL - VoiceEnvelope
 *
 * Turns a recorded loudness envelope into eight control-point radii.
 *
 * Pure maths, importing nothing from the Lens API, so the whole pipeline can be
 * exercised under plain Node. The microphone plumbing lives in
 * audio/VoiceThrow.ts; everything that decides what a hum SHAPES lives here.
 *
 * The pipeline is normalise -> smooth -> resample -> map, in that order, and
 * the order matters:
 *   - normalise first, so smoothing works on a full-scale signal rather than
 *     on whatever absolute level the room happened to give us;
 *   - smooth BEFORE resampling, because resampling 8 points out of a jittery
 *     envelope samples the jitter rather than averaging it away, and a single
 *     glottal crack would become a whole control point;
 *   - map last, so the radius floor is applied to a finished curve.
 */

/** Control points a voice throw produces. Matches CONTROL_POINTS. */
export const VOICE_POINTS = 8;

/**
 * Radius floor. A pot with a zero-radius ring is a pinched-off surface that
 * reads as a crease, and a silent moment mid-hum should still leave clay on
 * the wheel rather than cutting the vessel in half.
 */
export const MIN_RADIUS = 0.08;
export const MAX_RADIUS = 1.0;

/**
 * Smoothing width as a FRACTION of the recording length, not a fixed sample
 * count. A fixed window is wrong at both ends of the scale: five samples is a
 * gentle de-jitter across a 120-frame hum, but across an 8-value envelope it
 * averages over most of the signal and flattens the pot into a cylinder. Since
 * the editor path feeds 8 values through this same function, a fixed window
 * would make the simulator behave nothing like the microphone.
 */
export const SMOOTH_FRACTION = 0.08;
export const SMOOTH_WINDOW_MAX = 9;

/** Window for a signal of length n. Never wider than the detail we keep. */
export function smoothWindowFor(n: number): number {
  if (!isFinite(n) || n <= 0) return 1;
  // Never smooth across more than one output slot's worth of input, or the
  // resample step is averaging already-averaged neighbours.
  const perSlot = Math.floor(n / VOICE_POINTS);
  const w = Math.round(n * SMOOTH_FRACTION);
  return Math.max(1, Math.min(SMOOTH_WINDOW_MAX, Math.min(w, perSlot)));
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!isFinite(v)) return lo;
  return v < lo ? lo : (v > hi ? hi : v);
}

/** RMS of one audio frame. Returns 0 for an empty or non-finite frame. */
export function frameRms(frame: number[] | Float32Array, count: number): number {
  const n = Math.min(count, frame.length);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = frame[i];
    if (isFinite(s)) sum += s * s;
  }
  const mean = sum / n;
  return mean > 0 ? Math.sqrt(mean) : 0;
}

/**
 * Scale so the loudest moment is 1. A silent or flat recording returns all
 * zeros rather than dividing by zero - the caller treats that as "nothing said".
 */
export function normalizeEnvelope(values: number[]): number[] {
  const out: number[] = [];
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const v = isFinite(values[i]) ? Math.abs(values[i]) : 0;
    if (v > peak) peak = v;
  }
  if (peak <= 0) {
    for (let i = 0; i < values.length; i++) out.push(0);
    return out;
  }
  for (let i = 0; i < values.length; i++) {
    const v = isFinite(values[i]) ? Math.abs(values[i]) : 0;
    out.push(v / peak);
  }
  return out;
}

/**
 * Centred moving average. The window is clipped at both ends rather than
 * zero-padded: padding would drag the first and last values toward zero and
 * put a false pinch at the foot and the rim of every pot.
 */
export function smoothEnvelope(values: number[], window: number): number[] {
  const n = values.length;
  const out: number[] = [];
  if (n === 0) return out;
  const half = Math.max(0, Math.floor(window / 2));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = i - half; k <= i + half; k++) {
      if (k < 0 || k >= n) continue;
      sum += values[k];
      count++;
    }
    out.push(count > 0 ? sum / count : 0);
  }
  return out;
}

/**
 * Resample to exactly `count` values by averaging each source bucket, not by
 * point-sampling. Averaging keeps a loud instant that falls between two sample
 * points from vanishing.
 */
export function resampleEnvelope(values: number[], count: number): number[] {
  const out: number[] = [];
  const n = values.length;
  if (count <= 0) return out;
  if (n === 0) {
    for (let i = 0; i < count; i++) out.push(0);
    return out;
  }
  if (n <= count) {
    // Fewer samples than slots: stretch by nearest-neighbour rather than
    // inventing detail that was never recorded.
    for (let i = 0; i < count; i++) {
      const src = Math.min(n - 1, Math.floor((i * n) / count));
      out.push(values[src]);
    }
    return out;
  }
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * n) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / count));
    let sum = 0;
    let c = 0;
    for (let k = start; k < end && k < n; k++) {
      sum += values[k];
      c++;
    }
    out.push(c > 0 ? sum / c : 0);
  }
  return out;
}

/** Map a finished 0..1 envelope onto the legal radius band. */
export function envelopeToRadii(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = clamp(values[i], 0, 1);
    out.push(clamp(MIN_RADIUS + v * (MAX_RADIUS - MIN_RADIUS), MIN_RADIUS, MAX_RADIUS));
  }
  return out;
}

/**
 * Whole pipeline: raw per-frame loudness in, eight radii out. Also used by the
 * editor path, so the simulator exercises exactly what the microphone does.
 */
export function voiceToRadii(raw: number[]): number[] {
  const normalized = normalizeEnvelope(raw);
  const smoothed = smoothEnvelope(normalized, smoothWindowFor(raw.length));
  const resampled = resampleEnvelope(smoothed, VOICE_POINTS);
  return envelopeToRadii(resampled);
}

/** Evenly spread heights, 0..1, for the eight points. */
export function voiceHeights(): number[] {
  const out: number[] = [];
  for (let i = 0; i < VOICE_POINTS; i++) {
    out.push(i / (VOICE_POINTS - 1));
  }
  return out;
}
