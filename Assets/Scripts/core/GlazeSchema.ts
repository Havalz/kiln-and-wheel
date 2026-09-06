/**
 * WHEEL - GlazeSchema
 *
 * Validation, clamping, parsing and offline fallback for AI-authored glazes.
 * Pure logic: no Lens API, no network, no imports beyond the presets, so the
 * whole trust boundary around the model's reply is testable in plain Node.
 *
 * Everything an LLM returns is untrusted. It arrives as text that claims to be
 * JSON, may be wrapped in markdown, may omit fields, may invent fields, and may
 * put a number wildly out of range. Nothing here assumes otherwise.
 */

import {GLAZE_PRESETS} from "./GlazePresets";
// Interfaces are erased at runtime; a type-only import keeps this file
// loadable by plain Node type-stripping for the offline tests.
import type {GlazeParams, GlazePreset} from "./GlazePresets";

/** Legal range for every scalar parameter, matching GlazeMat's mainPass. */
export const GLAZE_RANGES: {[k: string]: [number, number]} = {
  roughness: [0, 1],
  metallic: [0, 1],
  crackleScale: [0, 60],
  crackleIntensity: [0, 1],
  dripAmount: [0, 1],
  glossBands: [0, 1],
  firedGlow: [0, 1]
};

/**
 * Waveguide floor. Black renders transparent, so no channel the model returns
 * may land below this or the glaze stops existing on the device. Matches the
 * shader's own GLAZE_FLOOR.
 */
export const MIN_CHANNEL = 0.30;

export interface GlazeResult {
  name: string;
  params: GlazeParams;
  /** True when this came from the local preset set rather than the model. */
  offline: boolean;
  /** Human-readable reason, shown on the panel when offline. */
  reason: string;
}

function num(v: any, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? n : fallback;
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Clamp a colour into legal range AND above the waveguide floor. Alpha is
 * clamped to 0..1 but not floored - only the RGB channels emit light.
 */
function clampColor(v: any, fallback: number[]): [number, number, number, number] {
  const src = Array.isArray(v) && v.length >= 3 ? v : fallback;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(clampNum(Math.max(num(src[i], fallback[i]), MIN_CHANNEL), 0, 1));
  }
  const a = src.length >= 4 ? num(src[3], 1) : 1;
  out.push(clampNum(a, 0, 1));
  return [out[0], out[1], out[2], out[3]];
}

/**
 * Force any object into a legal GlazeParams. Missing or nonsense fields fall
 * back to the matte-white baseline rather than throwing, so a partially-valid
 * model reply still produces a usable glaze.
 */
export function clampGlazeParams(raw: any): GlazeParams {
  const base = GLAZE_PRESETS[5].params; // matte white - the safest neutral
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    baseColorBottom: clampColor(r.baseColorBottom, base.baseColorBottom),
    baseColorTop: clampColor(r.baseColorTop, base.baseColorTop),
    roughness: clampNum(num(r.roughness, base.roughness), 0, 1),
    metallic: clampNum(num(r.metallic, base.metallic), 0, 1),
    crackleScale: clampNum(num(r.crackleScale, base.crackleScale), 0, 60),
    crackleIntensity: clampNum(num(r.crackleIntensity, base.crackleIntensity), 0, 1),
    dripAmount: clampNum(num(r.dripAmount, base.dripAmount), 0, 1),
    rimTint: clampColor(r.rimTint, base.rimTint),
    glossBands: clampNum(num(r.glossBands, base.glossBands), 0, 1),
    firedGlow: clampNum(num(r.firedGlow, base.firedGlow), 0, 1)
  };
}

/**
 * Pull a JSON object out of a model reply. Tolerates markdown fences and stray
 * prose either side, because "reply with ONLY JSON" is a request, not a
 * guarantee. Returns null only when there is no parseable object at all.
 */
export function parseGlazeReply(text: string): {name: string; params: GlazeParams} {
  if (typeof text !== "string" || text.length === 0) return null;

  let body = text.trim();
  // Strip ``` fences, with or without a language tag.
  body = body.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();

  // Fall back to the outermost brace pair if prose surrounds the object.
  if (body.charAt(0) !== "{") {
    const s = body.indexOf("{");
    const e = body.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return null;
    body = body.substring(s, e + 1);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const name = typeof parsed.name === "string" && parsed.name.length > 0
    ? parsed.name.substring(0, 40)
    : "Untitled Glaze";
  return {name: name, params: clampGlazeParams(parsed)};
}

/** Keyword weights per preset, used only when the network path fails. */
const PRESET_KEYWORDS: {[id: string]: string[]} = {
  celadon_crackle: ["celadon", "crackle", "craze", "crazed", "jade", "pale green",
                    "grey green", "ice", "sea", "mint"],
  tenmoku: ["tenmoku", "temmoku", "black", "brown", "dark", "iron", "oil spot",
            "chocolate", "espresso", "night"],
  copper_red: ["copper", "red", "oxblood", "sang", "crimson", "ruby", "blood",
               "scarlet", "cherry", "flame"],
  wood_ash: ["ash", "wood", "olive", "khaki", "drip", "runny", "run", "earth",
             "moss", "forest", "green gold"],
  cobalt_blue: ["cobalt", "blue", "azure", "sapphire", "navy", "indigo", "sky",
                "ocean", "delft"],
  matte_white: ["matte", "matt", "white", "chalk", "bone", "plain", "simple",
                "porcelain", "cream", "snow", "dry"]
};

/**
 * Closest local preset by keyword overlap. Always returns something - matte
 * white is the default when nothing matches, so the tool can never dead-end.
 */
export function matchPresetByKeywords(text: string): GlazePreset {
  const hay = (text || "").toLowerCase();
  let best: GlazePreset = null;
  let bestScore = 0;

  for (let i = 0; i < GLAZE_PRESETS.length; i++) {
    const preset = GLAZE_PRESETS[i];
    const words = PRESET_KEYWORDS[preset.id] || [];
    let score = 0;
    for (let w = 0; w < words.length; w++) {
      if (hay.indexOf(words[w]) !== -1) {
        // Longer keywords are more specific, so weight them higher.
        score += words[w].length >= 6 ? 2 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = preset;
    }
  }
  if (best === null) {
    for (let i = 0; i < GLAZE_PRESETS.length; i++) {
      if (GLAZE_PRESETS[i].id === "matte_white") return GLAZE_PRESETS[i];
    }
    return GLAZE_PRESETS[0];
  }
  return best;
}

/** Build the offline result for a transcript, with the reason to surface. */
export function offlineGlaze(transcript: string, reason: string): GlazeResult {
  const preset = matchPresetByKeywords(transcript);
  return {
    name: preset.name,
    params: preset.params,
    offline: true,
    reason: reason
  };
}

/** Transcript-keyed cache so repeating a phrase is instant. */
export class GlazeCache {
  private keys: string[] = [];
  private values: GlazeResult[] = [];
  private limit: number;

  constructor(limit: number = 32) {
    this.limit = limit > 0 ? limit : 32;
  }

  private norm(k: string): string {
    return (k || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  get(key: string): GlazeResult {
    const k = this.norm(key);
    const i = this.keys.indexOf(k);
    return i === -1 ? null : this.values[i];
  }

  set(key: string, value: GlazeResult): void {
    const k = this.norm(key);
    if (k.length === 0 || !value) return;
    const i = this.keys.indexOf(k);
    if (i !== -1) {
      this.values[i] = value;
      return;
    }
    this.keys.push(k);
    this.values.push(value);
    while (this.keys.length > this.limit) {
      this.keys.shift();
      this.values.shift();
    }
  }

  size(): number {
    return this.keys.length;
  }
}

/** The system instruction sent to Gemini. Kept here so it is testable too. */
export const GLAZE_SYSTEM_INSTRUCTION =
  "You are a ceramics glaze designer for an AR pottery studio. " +
  "Reply with ONLY a single JSON object. No markdown, no code fences, no prose, " +
  "no explanation before or after. The object must have exactly these keys:\n" +
  '"name": a short glaze name, at most 4 words.\n' +
  '"baseColorBottom": [r,g,b,a] floats 0-1, colour at the foot.\n' +
  '"baseColorTop": [r,g,b,a] floats 0-1, colour at the rim.\n' +
  '"roughness": float 0-1. "metallic": float 0-1.\n' +
  '"crackleScale": float 0-60, higher is a finer crackle network.\n' +
  '"crackleIntensity": float 0-1. "dripAmount": float 0-1.\n' +
  '"rimTint": [r,g,b,a] floats 0-1. "glossBands": float 0-1.\n' +
  '"firedGlow": float, always 0.\n' +
  "The input is a live speech transcript. On-device ASR auto-detects language " +
  "and has no locale setting, so English speech is sometimes returned as " +
  "phonetically similar words in another language (\"golden\" came back as " +
  "Turkish \"Golden'\u0131 bilek\"). Read the transcript phonetically as an " +
  "English description of a ceramic glaze and answer for the colour and finish " +
  "it most plausibly describes. Never refuse and never ask for clarification: " +
  "if it is unintelligible, return a plausible glaze anyway.\n" +
  "CRITICAL DISPLAY CONSTRAINT: this renders on a transparent waveguide where " +
  "black is invisible. Never return any colour channel below 0.30. A black or " +
  "very dark glaze must be expressed as a bright desaturated warm grey-brown, " +
  "conveying darkness through hue and contrast rather than low brightness.";
