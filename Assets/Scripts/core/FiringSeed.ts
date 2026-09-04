/**
 * WHEEL - FiringSeed
 *
 * The unpredictable-firing mechanic. Every firing derives a seed, and that seed
 * alone determines how the glaze comes out of the kiln. No two firings look
 * alike; the SAME seed always reproduces the same pot exactly.
 *
 * Determinism is the whole point, so this file is pure: no Lens API, no Date
 * except at seed-derivation time, no Math.random anywhere. Everything downstream
 * of deriveSeed() is a function of the seed.
 */

import {clampGlazeParams} from "./GlazeSchema";
import type {GlazeParams} from "./GlazePresets";

/** A crystal bloom: a local brightening where a crystal grew in the melt. */
export interface Bloom {
  /** Normalised height up the vessel, 0 foot .. 1 rim. */
  height: number;
  /** Normalised angle around the vessel, 0..1. */
  angle: number;
  /** Radius of the bloom in normalised surface units. */
  size: number;
  /** Local brightening strength. */
  intensity: number;
}

export interface FiringResult {
  seed: number;
  params: GlazeParams;
  blooms: Bloom[];
  /** What the kiln did, for the reveal line on the panel. */
  summary: string;
}

/** Deltas the kiln is allowed to apply. Tuned to be visible but not destructive. */
export const HUE_SHIFT_DEGREES = 12;
export const CRACKLE_DELTA = 0.3;
export const DRIP_DELTA = 0.25;
export const MIN_BLOOMS = 1;
export const MAX_BLOOMS = 3;

/**
 * mulberry32 - small, fast, well-distributed 32-bit PRNG (CC0).
 * Returns a function producing floats in [0,1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string. Stable across runs and platforms. */
function fnv1a(str: string, hash: number): number {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Seed from the piece itself: its silhouette, its glaze, and the moment it went
 * in. Two identical pots fired at different times come out different; the same
 * pot re-fired from a stored seed comes out identical.
 *
 * `nowMs` is a parameter rather than a Date.now() call inside so the derivation
 * stays testable and the caller controls the only nondeterministic input.
 */
export function deriveSeed(profileSerialized: string, glazeName: string, nowMs: number): number {
  let h = 0x811c9dc5;
  h = fnv1a(profileSerialized || "", h);
  h = fnv1a("|", h);
  h = fnv1a(glazeName || "", h);
  h = fnv1a("|", h);
  h = fnv1a(String(nowMs >>> 0), h);
  // Never hand back 0: mulberry32(0) is a valid but needlessly special stream.
  return (h >>> 0) || 0x9e3779b9;
}

// ── Colour ──────────────────────────────────────────────────────────────────

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h *= 60;
  if (h < 0) h += 360;
  return [h, mx === 0 ? 0 : d / mx, mx];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  return [r + m, g + m, b + m];
}

/** Rotate a colour's hue, preserving saturation and value. */
function shiftHue(c: number[], degrees: number): [number, number, number, number] {
  const hsv = rgbToHsv(c[0], c[1], c[2]);
  const rgb = hsvToRgb(hsv[0] + degrees, hsv[1], hsv[2]);
  return [rgb[0], rgb[1], rgb[2], c.length > 3 ? c[3] : 1];
}

// ── The firing ──────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Apply the kiln's seeded transformation to a glaze. Pure: same seed and same
 * input always produce the same output, on any machine, forever.
 */
export function fireGlaze(input: GlazeParams, seed: number): FiringResult {
  const rand = mulberry32(seed);

  // Draw order is part of the contract - reordering these changes every
  // previously-stored seed's result.
  const hue = (rand() * 2 - 1) * HUE_SHIFT_DEGREES;
  const crackleDelta = (rand() * 2 - 1) * CRACKLE_DELTA;
  const dripDelta = (rand() * 2 - 1) * DRIP_DELTA;
  const bloomCount = MIN_BLOOMS + Math.floor(rand() * (MAX_BLOOMS - MIN_BLOOMS + 1));

  const blooms: Bloom[] = [];
  for (let i = 0; i < bloomCount; i++) {
    blooms.push({
      // Blooms avoid the extreme foot and rim, where glaze is thinnest.
      height: 0.12 + rand() * 0.76,
      angle: rand(),
      size: 0.06 + rand() * 0.10,
      intensity: 0.35 + rand() * 0.45
    });
  }

  const fired = clampGlazeParams({
    baseColorBottom: shiftHue(input.baseColorBottom, hue),
    baseColorTop: shiftHue(input.baseColorTop, hue),
    rimTint: shiftHue(input.rimTint, hue),
    roughness: input.roughness,
    metallic: input.metallic,
    crackleScale: input.crackleScale,
    crackleIntensity: clamp01(input.crackleIntensity + crackleDelta),
    dripAmount: clamp01(input.dripAmount + dripDelta),
    glossBands: input.glossBands,
    firedGlow: 0
  });

  const dir = hue >= 0 ? "warmer" : "cooler";
  const summary =
    "hue " + (hue >= 0 ? "+" : "") + hue.toFixed(1) + "° " + dir +
    ", crackle " + (crackleDelta >= 0 ? "+" : "") + crackleDelta.toFixed(2) +
    ", drip " + (dripDelta >= 0 ? "+" : "") + dripDelta.toFixed(2) +
    ", " + bloomCount + " bloom" + (bloomCount === 1 ? "" : "s");

  return {seed: seed, params: fired, blooms: blooms, summary: summary};
}
