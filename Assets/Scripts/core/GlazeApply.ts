/**
 * WHEEL - GlazeApply
 *
 * The one place that pushes a GlazeParams onto a shader pass. Kept separate
 * from GlazePresets so that file stays free of Lens API types and remains
 * runnable under plain Node for the offline assertions.
 *
 * firedGlow is passed separately rather than read from the params: the same
 * recipe renders WET (no glow) on the wheel and FIRED (glowing) on the shelf,
 * so the glow belongs to the state, not to the glaze.
 */

import type {GlazeParams} from "./GlazePresets";

export function applyGlazeToPass(pass: any, g: GlazeParams, firedGlow: number): void {
  if (!pass || !g) return;
  pass.baseColorBottom = new vec4(
    g.baseColorBottom[0], g.baseColorBottom[1], g.baseColorBottom[2], g.baseColorBottom[3]);
  pass.baseColorTop = new vec4(
    g.baseColorTop[0], g.baseColorTop[1], g.baseColorTop[2], g.baseColorTop[3]);
  pass.rimTint = new vec4(g.rimTint[0], g.rimTint[1], g.rimTint[2], g.rimTint[3]);
  pass.roughness = g.roughness;
  pass.metallic = g.metallic;
  pass.crackleScale = g.crackleScale;
  pass.crackleIntensity = g.crackleIntensity;
  pass.dripAmount = g.dripAmount;
  pass.glossBands = g.glossBands;
  pass.firedGlow = firedGlow;
}
