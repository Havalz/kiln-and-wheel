/**
 * WHEEL - GlazePresets
 *
 * Six hardcoded glaze recipes, the offline fallback set. Plain data with no
 * Lens API imports, so it stays runnable in plain Node for verification.
 *
 * WAVEGUIDE RULE
 * --------------
 * Black renders TRANSPARENT on this display. A literal tenmoku or a true black
 * would simply not exist on the device. Every colour below is therefore floored
 * into bright desaturated warm greys and browns: the darkest channel value in
 * this file is 0.30 (verified in test), and the shader applies its own
 * GLAZE_FLOOR of 0.34 on top of that. What
 * reads as "black-brown" here is dark warm stone, never an absence of light.
 */

/** Mirrors the parameters exposed on GlazeMat's mainPass, one-to-one. */
export interface GlazeParams {
  baseColorBottom: [number, number, number, number];
  baseColorTop: [number, number, number, number];
  roughness: number;
  metallic: number;
  crackleScale: number;
  crackleIntensity: number;
  dripAmount: number;
  rimTint: [number, number, number, number];
  glossBands: number;
  firedGlow: number;
}

export interface GlazePreset {
  id: string;
  name: string;
  /** One-line note on what the recipe is imitating. */
  note: string;
  params: GlazeParams;
}

export const GLAZE_PRESETS: GlazePreset[] = [
  {
    id: "celadon_crackle",
    name: "Celadon Crackle",
    note: "Pale blue-green ash glaze with a fine crazed network.",
    params: {
      baseColorBottom: [0.52, 0.72, 0.66, 1.0],
      baseColorTop: [0.78, 0.92, 0.86, 1.0],
      roughness: 0.30,
      metallic: 0.0,
      crackleScale: 11.0,
      crackleIntensity: 0.85,
      dripAmount: 0.35,
      rimTint: [0.86, 1.0, 0.95, 0.55],
      glossBands: 0.55,
      firedGlow: 0.0
    }
  },
  {
    id: "tenmoku",
    name: "Tenmoku Black-Brown",
    note: "Iron-saturated dark glaze breaking rust-gold where it thins at the rim.",
    params: {
      // NOT black. Floored to a warm stone grey-brown so it survives the
      // waveguide; the darkness reads through hue and contrast, not luminance.
      baseColorBottom: [0.44, 0.38, 0.32, 1.0],
      baseColorTop: [0.72, 0.52, 0.30, 1.0],
      roughness: 0.22,
      metallic: 0.35,
      crackleScale: 5.0,
      crackleIntensity: 0.12,
      dripAmount: 0.85,
      rimTint: [1.0, 0.74, 0.36, 0.75],
      glossBands: 0.80,
      firedGlow: 0.0
    }
  },
  {
    id: "copper_red",
    name: "Copper Red",
    note: "Reduction-fired copper, deep at the foot and flushing pink at the rim.",
    params: {
      baseColorBottom: [0.68, 0.36, 0.34, 1.0],
      baseColorTop: [0.95, 0.55, 0.48, 1.0],
      roughness: 0.28,
      metallic: 0.20,
      crackleScale: 7.0,
      crackleIntensity: 0.25,
      dripAmount: 0.70,
      rimTint: [1.0, 0.72, 0.62, 0.70],
      glossBands: 0.65,
      firedGlow: 0.0
    }
  },
  {
    id: "wood_ash",
    name: "Wood Ash",
    note: "Running ash glaze, thick green-gold pooling where it gathers.",
    params: {
      baseColorBottom: [0.60, 0.62, 0.40, 1.0],
      baseColorTop: [0.88, 0.84, 0.62, 1.0],
      roughness: 0.42,
      metallic: 0.08,
      crackleScale: 4.0,
      crackleIntensity: 0.30,
      dripAmount: 1.0,
      rimTint: [1.0, 0.94, 0.68, 0.60],
      glossBands: 0.45,
      firedGlow: 0.0
    }
  },
  {
    id: "cobalt_blue",
    name: "Cobalt Blue",
    note: "Saturated cobalt, glassy and even, with a bright rim catch.",
    params: {
      baseColorBottom: [0.36, 0.46, 0.85, 1.0],
      baseColorTop: [0.58, 0.74, 1.0, 1.0],
      roughness: 0.18,
      metallic: 0.15,
      crackleScale: 9.0,
      crackleIntensity: 0.18,
      dripAmount: 0.40,
      rimTint: [0.78, 0.92, 1.0, 0.80],
      glossBands: 0.85,
      firedGlow: 0.0
    }
  },
  {
    id: "matte_white",
    name: "Matte White",
    note: "Dry unglossed white, almost no specular, barely any run.",
    params: {
      baseColorBottom: [0.82, 0.80, 0.76, 1.0],
      baseColorTop: [0.96, 0.95, 0.92, 1.0],
      roughness: 0.95,
      metallic: 0.0,
      crackleScale: 6.0,
      crackleIntensity: 0.08,
      dripAmount: 0.15,
      rimTint: [1.0, 0.98, 0.94, 0.35],
      glossBands: 0.05,
      firedGlow: 0.0
    }
  }
];

/** Lookup by id; null when unknown. */
export function getGlazePreset(id: string): GlazePreset {
  for (let i = 0; i < GLAZE_PRESETS.length; i++) {
    if (GLAZE_PRESETS[i].id === id) return GLAZE_PRESETS[i];
  }
  return null;
}

/**
 * Lowest colour channel across every preset. The waveguide guard asserts this
 * never approaches 0 -- see the Node check in the repo notes.
 */
export function darkestChannel(): number {
  let lo = 1.0;
  for (let i = 0; i < GLAZE_PRESETS.length; i++) {
    const p = GLAZE_PRESETS[i].params;
    const cols = [p.baseColorBottom, p.baseColorTop, p.rimTint];
    for (let c = 0; c < cols.length; c++) {
      for (let k = 0; k < 3; k++) {
        if (cols[c][k] < lo) lo = cols[c][k];
      }
    }
  }
  return lo;
}
