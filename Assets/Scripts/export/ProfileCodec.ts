/**
 * WHEEL - ProfileCodec
 *
 * A finished piece squeezed into 35 bytes, then base64url, so the whole pot
 * fits in a URL fragment and can be carried by a QR code. Pure logic: no Lens
 * API, no packages, so the format is testable in plain Node rather than only
 * on-device.
 *
 * 35 bytes is the budget because a base64url of 35 bytes is 47 characters with
 * no padding, which keeps the share URL short enough for a version-5 QR at EC
 * level L even after the https:// prefix.
 *
 * BYTE LAYOUT (fixed - never reorder, old links must keep decoding)
 *
 *   byte  0        version tag, always CODEC_VERSION
 *   bytes 1..16    8 control points, interleaved (y, r), each 0..1 -> round(v*255)
 *   byte  17       twist01,     0..1        -> round(v*255)
 *   byte  18       fluteCount,  integer 3..12, stored directly (no scaling)
 *   byte  19       fluteDepth,  0..0.35     -> round(v * 255/0.35)
 *   byte  20       height in cm, 0..255,      stored directly (no scaling)
 *   bytes 21..23   baseColorBottom r,g,b, each 0..1 -> round(v*255)
 *   bytes 24..26   baseColorTop    r,g,b, each 0..1 -> round(v*255)
 *   byte  27       roughness        0..1 -> round(v*255)
 *   byte  28       metallic         0..1 -> round(v*255)
 *   byte  29       crackleIntensity 0..1 -> round(v*255)
 *   byte  30       dripAmount       0..1 -> round(v*255)
 *   bytes 31..34   firing seed, uint32 BIG-ENDIAN
 *
 * The seed is big-endian so a hex dump of the tail reads the same way the seed
 * is printed in the Logger, which makes a mis-scanned link obvious by eye.
 */

import {CONTROL_POINTS} from "../core/ProfileModel";
// Interfaces are erased at runtime; the type-only import keeps this file
// loadable by plain Node type-stripping for the offline round-trip tests.
import type {ProfilePoint} from "../core/ProfileModel";

/** Bumped only when the layout changes. decodeBytes refuses anything else. */
export const CODEC_VERSION = 1;

/** Exact payload size. Anything else is a corrupt scan, not a new format. */
export const CODEC_BYTES = 35;

/** Upper bound of the fluteDepth field; the byte scale is derived from it. */
export const FLUTE_DEPTH_MAX = 0.35;

/** Legal flute counts, matching the wheel's own control range. */
export const FLUTE_COUNT_MIN = 3;
export const FLUTE_COUNT_MAX = 12;

/** Height is stored raw in one byte, so this is the tallest storable pot. */
export const HEIGHT_MAX_CM = 255;

/** Worst-case error of an 8-bit quantised 0..1 field, plus float slack. */
export const QUANT_TOLERANCE = 1 / 255 + 1e-6;

/** base64url alphabet: URL-safe, no padding, so the fragment needs no escaping. */
export const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface PieceData {
  /** Exactly CONTROL_POINTS entries; encode pads or truncates to that. */
  points: ProfilePoint[];
  twist01: number;
  fluteCount: number;
  fluteDepth: number;
  /** Centimetres. */
  height: number;
  baseColorBottom: [number, number, number];
  baseColorTop: [number, number, number];
  roughness: number;
  metallic: number;
  crackleIntensity: number;
  dripAmount: number;
  /** uint32. Values at or above 2^31 must survive, so all shifts are unsigned. */
  seed: number;
}

/* ------------------------------------------------------------------ *
 * Quantisation helpers.
 *
 * Every one of these is total: a NaN, an Infinity, a string, or a value
 * far outside range still yields an integer in 0..255. A byte outside
 * that range would silently corrupt the base64url packing, so nothing
 * is allowed to reach the packer unclamped.
 * ------------------------------------------------------------------ */

function finite(v: any, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 0..1 float -> byte. */
function q01(v: any): number {
  return Math.round(clamp(finite(v, 0), 0, 1) * 255);
}

/** byte -> 0..1 float. */
function d01(b: number): number {
  return (b & 255) / 255;
}

/** Store a value that already IS a byte-sized integer (count, height). */
function qRaw(v: any, lo: number, hi: number): number {
  return Math.round(clamp(finite(v, lo), lo, hi));
}

/** 0..FLUTE_DEPTH_MAX -> byte, using the full 8-bit range for resolution. */
function qFluteDepth(v: any): number {
  return Math.round(clamp(finite(v, 0), 0, FLUTE_DEPTH_MAX) * (255 / FLUTE_DEPTH_MAX));
}

function dFluteDepth(b: number): number {
  return (b & 255) * (FLUTE_DEPTH_MAX / 255);
}

/** Any number -> uint32. ToUint32 semantics wrap rather than throw. */
function toUint32(v: any): number {
  const n = finite(v, 0);
  return Math.floor(n) >>> 0;
}

function colorTriple(v: any): [number, number, number] {
  const src = Array.isArray(v) ? v : [];
  return [finite(src[0], 0), finite(src[1], 0), finite(src[2], 0)];
}

/* ------------------------------------------------------------------ *
 * Byte encoding.
 * ------------------------------------------------------------------ */

/**
 * Pack a piece into exactly CODEC_BYTES values in 0..255.
 *
 * A malformed piece (short point list, missing colour, NaN scalar) still
 * produces a well-formed 35-byte payload. Refusing to encode would strand
 * the user with a fired pot and no way to take it home; a slightly wrong
 * pot is the better failure.
 */
export function encodeBytes(p: PieceData): number[] {
  const src = (p || {}) as PieceData;
  const bytes: number[] = new Array(CODEC_BYTES);

  bytes[0] = CODEC_VERSION;

  const pts = Array.isArray(src.points) ? src.points : [];
  for (let i = 0; i < CONTROL_POINTS; i++) {
    const pt = pts[i] || {y: 0, r: 0};
    bytes[1 + i * 2] = q01(pt.y);
    bytes[2 + i * 2] = q01(pt.r);
  }

  bytes[17] = q01(src.twist01);
  bytes[18] = qRaw(src.fluteCount, FLUTE_COUNT_MIN, FLUTE_COUNT_MAX);
  bytes[19] = qFluteDepth(src.fluteDepth);
  bytes[20] = qRaw(src.height, 0, HEIGHT_MAX_CM);

  const bot = colorTriple(src.baseColorBottom);
  const top = colorTriple(src.baseColorTop);
  bytes[21] = q01(bot[0]);
  bytes[22] = q01(bot[1]);
  bytes[23] = q01(bot[2]);
  bytes[24] = q01(top[0]);
  bytes[25] = q01(top[1]);
  bytes[26] = q01(top[2]);

  bytes[27] = q01(src.roughness);
  bytes[28] = q01(src.metallic);
  bytes[29] = q01(src.crackleIntensity);
  bytes[30] = q01(src.dripAmount);

  const seed = toUint32(src.seed);
  bytes[31] = (seed >>> 24) & 255;
  bytes[32] = (seed >>> 16) & 255;
  bytes[33] = (seed >>> 8) & 255;
  bytes[34] = seed & 255;

  return bytes;
}

/**
 * Unpack. Returns null - never throws and never guesses - when the length or
 * the version tag is wrong, because a half-understood pot is worse than no pot.
 */
export function decodeBytes(bytes: number[]): PieceData | null {
  if (!bytes || bytes.length !== CODEC_BYTES) {
    return null;
  }
  if ((bytes[0] & 255) !== CODEC_VERSION) {
    return null;
  }

  const points: ProfilePoint[] = [];
  for (let i = 0; i < CONTROL_POINTS; i++) {
    points.push({y: d01(bytes[1 + i * 2]), r: d01(bytes[2 + i * 2])});
  }

  const seed =
    (((bytes[31] & 255) << 24) |
      ((bytes[32] & 255) << 16) |
      ((bytes[33] & 255) << 8) |
      (bytes[34] & 255)) >>>
    0;

  return {
    points: points,
    twist01: d01(bytes[17]),
    fluteCount: bytes[18] & 255,
    fluteDepth: dFluteDepth(bytes[19]),
    height: bytes[20] & 255,
    baseColorBottom: [d01(bytes[21]), d01(bytes[22]), d01(bytes[23])],
    baseColorTop: [d01(bytes[24]), d01(bytes[25]), d01(bytes[26])],
    roughness: d01(bytes[27]),
    metallic: d01(bytes[28]),
    crackleIntensity: d01(bytes[29]),
    dripAmount: d01(bytes[30]),
    seed: seed
  };
}

/* ------------------------------------------------------------------ *
 * base64url. Hand-rolled because atob/btoa and Buffer do not exist in
 * the Lens runtime, and a package dependency for 20 lines is not worth
 * the build surface.
 * ------------------------------------------------------------------ */

let reverseLookup: number[] = null;

function b64Reverse(): number[] {
  if (reverseLookup === null) {
    const table: number[] = new Array(128);
    for (let i = 0; i < 128; i++) {
      table[i] = -1;
    }
    for (let i = 0; i < B64URL_ALPHABET.length; i++) {
      table[B64URL_ALPHABET.charCodeAt(i)] = i;
    }
    reverseLookup = table;
  }
  return reverseLookup;
}

/** Bytes -> base64url, no '=' padding (padding is illegal in a URL fragment). */
export function toBase64Url(bytes: number[]): string {
  if (!bytes) {
    return "";
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] & 255;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] & 255 : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] & 255 : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL_ALPHABET.charAt((n >>> 18) & 63);
    out += B64URL_ALPHABET.charAt((n >>> 12) & 63);
    if (i + 1 < bytes.length) {
      out += B64URL_ALPHABET.charAt((n >>> 6) & 63);
    }
    if (i + 2 < bytes.length) {
      out += B64URL_ALPHABET.charAt(n & 63);
    }
  }
  return out;
}

/** base64url -> bytes. Null on any character outside the alphabet. */
export function fromBase64Url(s: string): number[] | null {
  if (typeof s !== "string") {
    return null;
  }
  // A length of 4n+1 cannot come from any byte string; reject rather than
  // silently drop the orphan sextet.
  if (s.length % 4 === 1) {
    return null;
  }
  const table = b64Reverse();
  const out: number[] = [];
  let acc = 0;
  let accBits = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const v = code < 128 ? table[code] : -1;
    if (v < 0) {
      return null;
    }
    acc = (acc << 6) | v;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out.push((acc >>> accBits) & 255);
    }
  }
  return out;
}

/** The share payload: everything about the piece, as 47 URL-safe characters. */
export function encode(p: PieceData): string {
  return toBase64Url(encodeBytes(p));
}

export function decode(s: string): PieceData | null {
  const bytes = fromBase64Url(s);
  if (bytes === null) {
    return null;
  }
  return decodeBytes(bytes);
}

/* ------------------------------------------------------------------ *
 * Self test.
 *
 * Runs offline in plain Node and on-device from the Logger. The extremes
 * matter more than the typical case: seed 0xFFFFFFFF and 0x80000000 are the
 * ones a signed >> would silently destroy, and a share link that decodes to
 * a different firing is indistinguishable from a broken one.
 * ------------------------------------------------------------------ */

function makePoints(fill: (i: number) => ProfilePoint): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  for (let i = 0; i < CONTROL_POINTS; i++) {
    pts.push(fill(i));
  }
  return pts;
}

function piece(over: Partial<PieceData>): PieceData {
  const base: PieceData = {
    points: makePoints(() => ({y: 0, r: 0})),
    twist01: 0,
    fluteCount: FLUTE_COUNT_MIN,
    fluteDepth: 0,
    height: 0,
    baseColorBottom: [0, 0, 0],
    baseColorTop: [0, 0, 0],
    roughness: 0,
    metallic: 0,
    crackleIntensity: 0,
    dripAmount: 0,
    seed: 0
  };
  const merged = base as any;
  const src = over as any;
  for (const k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      merged[k] = src[k];
    }
  }
  return merged as PieceData;
}

export function selfTest(): {ok: boolean; failures: string[]} {
  const failures: string[] = [];

  const near = (label: string, got: number, want: number, tol: number): void => {
    if (!isFinite(got) || Math.abs(got - want) > tol) {
      failures.push(label + ": got " + got + " want " + want + " (tol " + tol + ")");
    }
  };
  const exact = (label: string, got: number, want: number): void => {
    if (got !== want) {
      failures.push(label + ": got " + got + " want " + want + " (exact)");
    }
  };

  const cases: {name: string; p: PieceData}[] = [
    {
      name: "all-zero",
      p: piece({})
    },
    {
      name: "all-max",
      p: piece({
        points: makePoints(() => ({y: 1, r: 1})),
        twist01: 1,
        fluteCount: FLUTE_COUNT_MAX,
        fluteDepth: FLUTE_DEPTH_MAX,
        height: HEIGHT_MAX_CM,
        baseColorBottom: [1, 1, 1],
        baseColorTop: [1, 1, 1],
        roughness: 1,
        metallic: 1,
        crackleIntensity: 1,
        dripAmount: 1,
        seed: 4294967295
      })
    },
    {
      name: "mid",
      p: piece({
        points: makePoints((i) => ({y: i / (CONTROL_POINTS - 1), r: 0.5})),
        twist01: 0.5,
        fluteCount: 7,
        fluteDepth: 0.175,
        height: 18,
        baseColorBottom: [0.5, 0.25, 0.75],
        baseColorTop: [0.9, 0.4, 0.1],
        roughness: 0.5,
        metallic: 0.5,
        crackleIntensity: 0.5,
        dripAmount: 0.5,
        seed: 123456
      })
    },
    {
      name: "vase-fractional",
      p: piece({
        points: makePoints((i) => ({
          y: i / (CONTROL_POINTS - 1),
          r: 0.18 + 0.42 * Math.sin((i / (CONTROL_POINTS - 1)) * Math.PI)
        })),
        twist01: 0.3125,
        fluteCount: 9,
        fluteDepth: 0.27,
        height: 231,
        baseColorBottom: [0.37, 0.81, 0.62],
        baseColorTop: [0.04, 0.93, 0.55],
        roughness: 0.13,
        metallic: 0.87,
        crackleIntensity: 0.61,
        dripAmount: 0.02,
        seed: 1
      })
    },
    {
      name: "seed-2^31 (signed-shift trap)",
      p: piece({seed: 2147483648, fluteCount: 5, height: 12})
    },
    {
      name: "seed-0xDEADBEEF",
      p: piece({seed: 3735928559, fluteCount: 12, height: 200})
    },
    {
      name: "seed-max",
      p: piece({seed: 4294967295})
    },
    {
      name: "seed-zero",
      p: piece({seed: 0})
    }
  ];

  for (let c = 0; c < cases.length; c++) {
    const name = cases[c].name;
    const p = cases[c].p;

    const bytes = encodeBytes(p);
    if (bytes.length !== CODEC_BYTES) {
      failures.push(name + " / length: got " + bytes.length + " want " + CODEC_BYTES);
      continue;
    }
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (!isFinite(b) || b < 0 || b > 255 || Math.floor(b) !== b) {
        failures.push(name + " / byte " + i + " out of range: " + b);
      }
    }

    const text = encode(p);
    if (text.length !== 47) {
      failures.push(name + " / base64url length: got " + text.length + " want 47");
    }
    if (text.indexOf("=") !== -1 || text.indexOf("+") !== -1 || text.indexOf("/") !== -1) {
      failures.push(name + " / base64url contains non-url-safe characters: " + text);
    }

    const q = decode(text);
    if (q === null) {
      failures.push(name + " / decode returned null for " + text);
      continue;
    }

    for (let i = 0; i < CONTROL_POINTS; i++) {
      near(name + " / point[" + i + "].y", q.points[i].y, clamp(p.points[i].y, 0, 1), QUANT_TOLERANCE);
      near(name + " / point[" + i + "].r", q.points[i].r, clamp(p.points[i].r, 0, 1), QUANT_TOLERANCE);
    }
    near(name + " / twist01", q.twist01, p.twist01, QUANT_TOLERANCE);
    near(name + " / fluteDepth", q.fluteDepth, p.fluteDepth, QUANT_TOLERANCE);
    near(name + " / bottom.r", q.baseColorBottom[0], p.baseColorBottom[0], QUANT_TOLERANCE);
    near(name + " / bottom.g", q.baseColorBottom[1], p.baseColorBottom[1], QUANT_TOLERANCE);
    near(name + " / bottom.b", q.baseColorBottom[2], p.baseColorBottom[2], QUANT_TOLERANCE);
    near(name + " / top.r", q.baseColorTop[0], p.baseColorTop[0], QUANT_TOLERANCE);
    near(name + " / top.g", q.baseColorTop[1], p.baseColorTop[1], QUANT_TOLERANCE);
    near(name + " / top.b", q.baseColorTop[2], p.baseColorTop[2], QUANT_TOLERANCE);
    near(name + " / roughness", q.roughness, p.roughness, QUANT_TOLERANCE);
    near(name + " / metallic", q.metallic, p.metallic, QUANT_TOLERANCE);
    near(name + " / crackleIntensity", q.crackleIntensity, p.crackleIntensity, QUANT_TOLERANCE);
    near(name + " / dripAmount", q.dripAmount, p.dripAmount, QUANT_TOLERANCE);

    exact(name + " / fluteCount", q.fluteCount, p.fluteCount);
    exact(name + " / height", q.height, p.height);
    exact(name + " / seed", q.seed, p.seed);
  }

  // Hostile input must still yield legal bytes rather than a corrupt payload.
  const dirty = encodeBytes({
    points: [{y: NaN, r: 99}, {y: -5, r: Infinity}],
    twist01: NaN,
    fluteCount: 900,
    fluteDepth: -1,
    height: 1e9,
    baseColorBottom: null,
    baseColorTop: [NaN, -3, 7],
    roughness: undefined,
    metallic: NaN,
    crackleIntensity: 4,
    dripAmount: -0.5,
    seed: NaN
  } as any);
  if (dirty.length !== CODEC_BYTES) {
    failures.push("dirty / length: got " + dirty.length);
  }
  for (let i = 0; i < dirty.length; i++) {
    const b = dirty[i];
    if (!isFinite(b) || b < 0 || b > 255 || Math.floor(b) !== b) {
      failures.push("dirty / byte " + i + " out of range: " + b);
    }
  }
  const dirtyBack = decodeBytes(dirty);
  if (dirtyBack === null) {
    failures.push("dirty / decodeBytes returned null on self-produced payload");
  } else if (dirtyBack.fluteCount < FLUTE_COUNT_MIN || dirtyBack.fluteCount > FLUTE_COUNT_MAX) {
    failures.push("dirty / fluteCount escaped range: " + dirtyBack.fluteCount);
  }

  // Rejection paths.
  if (decodeBytes([]) !== null) {
    failures.push("reject / empty byte array decoded");
  }
  if (decodeBytes(new Array(CODEC_BYTES + 1).fill(0)) !== null) {
    failures.push("reject / oversized byte array decoded");
  }
  const badVersion = encodeBytes(piece({}));
  badVersion[0] = 0xff;
  if (decodeBytes(badVersion) !== null) {
    failures.push("reject / unknown version tag decoded");
  }
  if (fromBase64Url("abc*def") !== null) {
    failures.push("reject / base64url accepted an illegal character");
  }
  if (fromBase64Url("abcde") !== null) {
    failures.push("reject / base64url accepted a 4n+1 length");
  }
  if (decode("not-a-real-payload") !== null) {
    failures.push("reject / short payload decoded");
  }

  return {ok: failures.length === 0, failures: failures};
}
