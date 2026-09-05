/**
 * GLAZE FALLBACK — the bench must never dead-end on the network.
 *
 * The failure is FORCED with a bogus model id rather than relying on the
 * tokens happening to be expired, so the test means the same thing whether or
 * not the gateway is reachable. Both the model id and the transcript are put
 * back afterwards, because scenarios share one live Lens.
 */

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario";
import {expect} from "Leaf.lspkg/Utils/common/Expect";
import {findSceneObjectByName, findSceneObjectsByName, sleep} from "Leaf.lspkg/Utils/common/Utils";
import {GlazeBenchVoice} from "../GlazeBenchVoice";

/** The contract: 20s ceiling, then a local preset. Allow a little scheduling slack. */
const TIMEOUT_MS = 20000;
const SLACK_MS = 3000;
const POLL_MS = 250;

/** Set by applyResult() as `<reason> — used offline glaze: <name>`. */
const OFFLINE_MARKER = "used offline glaze";

/** The glaze status line is a RowText; find it by what it says, not by index. */
function findStatusContaining(fragment: string): string | null {
  const rows = findSceneObjectsByName("RowText");
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].getComponent("Component.Text") as Text;
    if (t && t.text && t.text.includes(fragment)) return t.text;
  }
  return null;
}

@component
export class GlazeFallbackScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1500);

    const host = findSceneObjectByName("WHEEL Studio UI");
    expect(host).not.toBe(null);
    const bench = host.getComponent(GlazeBenchVoice.getTypeName()) as GlazeBenchVoice;
    expect(bench).not.toBe(null);

    const modelBefore = bench.geminiModel;
    const typedBefore = bench.typedGlaze;

    try {
      // A model id that cannot resolve through RSG: the request fails, and the
      // failure path is what this scenario is about.
      bench.geminiModel = "leaf-test-nonexistent-model";
      bench.typedGlaze = "a deep celadon with fine crackle";
      bench.runTypedGlaze = true;

      const started = Date.now();
      let notice: string | null = null;
      while (Date.now() - started < TIMEOUT_MS + SLACK_MS) {
        await sleep(POLL_MS);
        notice = findStatusContaining(OFFLINE_MARKER);
        if (notice !== null) break;
      }
      const elapsed = Date.now() - started;

      // The panel says so, in the user's words, not just the log.
      expect(notice).not.toBe(null);
      expect(notice.includes(OFFLINE_MARKER)).toBe(true);
      // And it happened inside the promised ceiling.
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed < TIMEOUT_MS + SLACK_MS).toBe(true);

      print("[LEAF] GLAZE FALLBACK after " + elapsed + "ms: \"" + notice + "\"");
    } finally {
      // Leave the bench exactly as it was found.
      bench.geminiModel = modelBefore;
      bench.typedGlaze = typedBefore;
      bench.runTypedGlaze = false;
    }
  }
}
