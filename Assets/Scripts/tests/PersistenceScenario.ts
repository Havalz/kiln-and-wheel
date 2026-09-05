/**
 * PERSISTENCE — a saved piece must come back byte-identical.
 *
 * WHAT "clear the scene, reload" MEANS HERE. A scenario cannot restart the
 * Lens, so it cannot literally tear the scene down. What it can do is exercise
 * the identical code path a restart takes: write through serializeShelf into
 * PersistentStorageSystem, drop every in-memory reference, then rebuild purely
 * from the stored string with deserializeShelf - which is exactly what
 * ShelfManager.load() does on start. The storage layer, not the scene, is what
 * this test is actually about.
 *
 * The real shelf is snapshotted and restored, because a test must not cost the
 * user their pots.
 */

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario";
import {expect} from "Leaf.lspkg/Utils/common/Expect";
import {findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils";
import {LatheMesher} from "../core/LatheMesher";
import {STORAGE_KEY} from "../ShelfManager";
import {addPiece, deserializeShelf, localName, serializeShelf} from "../core/ShelfStore";
import type {ShelfPiece} from "../core/ShelfStore";
import {GLAZE_PRESETS} from "../core/GlazePresets";

@component
export class PersistenceScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1500);

    const lathe = findSceneObjectByName("WHEEL Lathe");
    const mesher = lathe.getComponent(LatheMesher.getTypeName()) as LatheMesher;
    expect(mesher).not.toBe(null);

    const store = global.persistentStorageSystem.store;
    const hadKey = store.has(STORAGE_KEY);
    const backup = hadKey ? store.getString(STORAGE_KEY) : "";

    try {
      // A piece built from the pot actually on the wheel, so the profile bytes
      // under test are real geometry rather than a fixture.
      const seed = 3028517782;   // above 2^31 on purpose: unsigned handling
      const profileBytes = mesher.getModel().serialize();
      expect(profileBytes.length).toBeGreaterThan(0);

      const piece: ShelfPiece = {
        profileBytes: profileBytes,
        glazeParams: GLAZE_PRESETS[0].params,
        seed: seed,
        name: localName(seed),
        createdAt: Date.now()
      };

      // Save through the same functions ShelfManager uses.
      const saved = addPiece(deserializeShelf(backup), piece);
      store.putString(STORAGE_KEY, serializeShelf(saved));

      // Drop everything in memory. From here on only the stored string exists.
      let reloaded: ShelfPiece[] | null = null;
      expect(store.has(STORAGE_KEY)).toBe(true);
      reloaded = deserializeShelf(store.getString(STORAGE_KEY));

      // Find it the way a reload would - by seed, not by position.
      let found: ShelfPiece | null = null;
      for (let i = 0; i < reloaded.length; i++) {
        if (reloaded[i].seed === seed) found = reloaded[i];
      }
      expect(found).not.toBe(null);

      // The whole point: identical profile bytes, character for character.
      expect(found.profileBytes).toBe(profileBytes);
      expect(found.profileBytes.length).toBe(profileBytes.length);
      // The seed survives the JSON round trip unsigned.
      expect(found.seed).toBe(seed);
      expect(found.name).toBe(localName(seed));
      // And the glaze came back intact, since a piece is profile + glaze + seed.
      expect(found.glazeParams.crackleIntensity)
        .toBeCloseTo(GLAZE_PRESETS[0].params.crackleIntensity, 6);

      print("[LEAF] PERSISTENCE round-tripped " + profileBytes.length +
            " profile bytes, seed " + seed + ", name \"" + found.name + "\"");
    } finally {
      // Put the user's shelf back exactly as it was, including "was absent".
      if (hadKey) {
        store.putString(STORAGE_KEY, backup);
      } else {
        store.remove(STORAGE_KEY);
      }
    }
  }
}
