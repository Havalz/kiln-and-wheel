/**
 * WHEEL - PotAcoustics
 *
 * The maths behind the two audio behaviours: how wide the pot is where you are
 * shaping it, and how much clay is in the finished piece. Pure functions with
 * no Lens API, so the mappings are testable offline.
 *
 * A note on why this file exists at all: AudioComponent on Specs exposes no
 * pitch or playback-rate control. Both features are specified in terms of pitch,
 * so pitch has to come from choosing between pre-rendered clips (the ping) or
 * crossfading two clips of different fundamentals (the hum). These functions
 * produce the blend/selection values that stand in for a pitch knob.
 */

import type {ProfilePoint} from "./ProfileModel";

/** Clip choices for the ping, ordered low to high. */
export type BellPitch = "low" | "mid" | "high";

function clamp01(v: number): number {
  return !isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Volume of the solid of revolution, in cm^3, by the disc method:
 * V = SUM over samples of PI * r^2 * dy.
 *
 * This is the OUTER volume of the form - the vessel is treated as solid clay,
 * which is what determines how much material is ringing. Modelling the hollow
 * interior would need a wall thickness the lathe does not have.
 */
export function potVolume(samples: ProfilePoint[], heightCm: number, radiusScaleCm: number): number {
  if (!samples || samples.length < 2 || heightCm <= 0 || radiusScaleCm <= 0) return 0;
  let v = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const y0 = samples[i].y * heightCm;
    const y1 = samples[i + 1].y * heightCm;
    const dy = y1 - y0;
    if (dy <= 0) continue;
    // Average the two radii across the slice rather than taking one end -
    // a plain left-hand sum visibly under-reads a flared rim.
    const r0 = samples[i].r * radiusScaleCm;
    const r1 = samples[i + 1].r * radiusScaleCm;
    const rMid = (r0 + r1) * 0.5;
    v += Math.PI * rMid * rMid * dy;
  }
  return v;
}

/**
 * Reference span for mapping volume to pitch, in cm^3. A 22cm pot at the
 * default 7cm radius scale lands near the middle of this range.
 */
export const VOLUME_MIN = 150;
export const VOLUME_MAX = 2600;

/**
 * Small pot = higher note. Returns 0..1 where 1 is the highest pitch, so the
 * mapping reads the same way round as the physical intuition.
 */
export function volumeToPitch01(volumeCm3: number): number {
  const t = (volumeCm3 - VOLUME_MIN) / (VOLUME_MAX - VOLUME_MIN);
  return clamp01(1 - clamp01(t));
}

/** Pick the nearest pre-rendered bell for a pitch position. */
export function pitchToBell(pitch01: number): BellPitch {
  const p = clamp01(pitch01);
  if (p < 0.34) return "low";
  if (p < 0.67) return "mid";
  return "high";
}

/**
 * Radius at a control point, normalised 0..1 against the widest the profile is
 * allowed to be. Drives the hum: wide = low and full, narrow = high and thin.
 */
export function radiusAt(points: ProfilePoint[], index: number): number {
  if (!points || index < 0 || index >= points.length) return 0;
  return clamp01(points[index].r);
}

/**
 * Crossfade position between the low and high hum loops. Wide radius pulls
 * toward the low loop, narrow toward the high one.
 * Returns 0 = fully low, 1 = fully high.
 */
export function radiusToHumBlend(radius01: number): number {
  return clamp01(1 - clamp01(radius01));
}

/**
 * Overall hum loudness. A wide pot moves more clay and should be fuller, but a
 * narrow one must stay audible, so the floor is well above zero.
 */
export function radiusToHumGain(radius01: number): number {
  return 0.45 + 0.55 * clamp01(radius01);
}

/** Equal-power crossfade pair for a blend position. Avoids the volume dip a linear fade gives. */
export function crossfadeGains(blend01: number): {low: number; high: number} {
  const b = clamp01(blend01);
  return {
    low: Math.cos(b * Math.PI * 0.5),
    high: Math.sin(b * Math.PI * 0.5)
  };
}
