/**
 * FIRING — the 6s sequence must reach FIRED, and the seed must be what decides
 * how the piece comes out.
 *
 * TWO LEVELS ON PURPOSE. The state machine is exercised through the live
 * KilnStation. The "different seeds give different glaze" half is exercised
 * against fireGlaze() directly, because KilnStation.fire() is one-shot per Lens
 * session - it returns early once `fired` is set and there is no reset - so a
 * second live firing is impossible without changing the Lens. fireGlaze IS the
 * transformation under test; the kiln only supplies it a seed.
 */

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario";
import {expect} from "Leaf.lspkg/Utils/common/Expect";
import {findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils";
import {KilnStation} from "../KilnStation";
import {fireGlaze} from "../core/FiringSeed";
import {GLAZE_PRESETS} from "../core/GlazePresets";

/** The sequence is 6.0s by contract; allow for frame scheduling. */
const SEQUENCE_MS = 6000;
const SLACK_MS = 4000;
const POLL_MS = 250;

function paramsDiffer(a: any, b: any): boolean {
  if (Math.abs(a.crackleIntensity - b.crackleIntensity) > 1e-9) return true;
  if (Math.abs(a.dripAmount - b.dripAmount) > 1e-9) return true;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.baseColorTop[i] - b.baseColorTop[i]) > 1e-9) return true;
    if (Math.abs(a.baseColorBottom[i] - b.baseColorBottom[i]) > 1e-9) return true;
  }
  return false;
}

@component
export class FiringScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1500);

    const host = findSceneObjectByName("WHEEL Studio UI");
    const kiln = host.getComponent(KilnStation.getTypeName()) as KilnStation;
    expect(kiln).not.toBe(null);

    // ── Part 1: the live state machine ──────────────────────────────────────
    if (kiln.isFired()) {
      // One-shot by design. Say so rather than reporting a false pass.
      throw new Error(
        "Kiln is already FIRED from an earlier scenario or manual firing. " +
        "fire() is one-shot per Lens session with no reset, so restart the " +
        "preview before re-running FIRING.");
    }

    const started = Date.now();
    kiln.fire();

    let elapsed = 0;
    while (elapsed < SEQUENCE_MS + SLACK_MS) {
      await sleep(POLL_MS);
      elapsed = Date.now() - started;
      if (kiln.isFired()) break;
    }

    expect(kiln.isFired()).toBe(true);
    const seed = kiln.getSeed();
    expect(seed).toBeGreaterThan(0);
    // It took roughly the promised six seconds, not zero and not forever.
    expect(elapsed).toBeGreaterThan(SEQUENCE_MS * 0.5);
    expect(elapsed < SEQUENCE_MS + SLACK_MS).toBe(true);
    print("[LEAF] FIRING reached FIRED in " + elapsed + "ms, seed " + seed);

    // ── Part 2: the seed is what varies the result ──────────────────────────
    const base = GLAZE_PRESETS[0].params;
    const a = fireGlaze(base, 12345);
    const b = fireGlaze(base, 987654321);
    const aAgain = fireGlaze(base, 12345);

    // Different seeds must not produce the same pot.
    expect(paramsDiffer(a.params, b.params)).toBe(true);
    expect(a.seed).not.toBe(b.seed);
    // And the same seed must reproduce exactly - that is what makes a stored
    // piece replayable and what the QR export depends on.
    expect(paramsDiffer(a.params, aAgain.params)).toBe(false);
    expect(a.summary).toBe(aAgain.summary);

    // The live seed must behave the same way as the synthetic ones.
    const live = fireGlaze(base, seed);
    const liveAgain = fireGlaze(base, seed);
    expect(paramsDiffer(live.params, liveAgain.params)).toBe(false);

    print("[LEAF] FIRING seed 12345 -> " + a.summary);
    print("[LEAF] FIRING seed 987654321 -> " + b.summary);
  }
}
