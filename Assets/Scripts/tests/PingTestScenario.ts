/**
 * PING TEST — tapping a fired pot must ring it and change nothing else.
 *
 * This guards a regression that shipped: placement was bound to onTriggerEnd,
 * which fires on ANY release, so every ping test also dropped the pot across
 * the room and left it intersecting the wheel panel. The assertions here are
 * deliberately exact rather than approximate - "close enough" would pass a bug
 * that nudged the piece a millimetre on every inspection.
 *
 * The second half proves the panel guard: a real placement drag must land the
 * vessel clear of all four station plates.
 */

import {Scenario} from "Leaf.lspkg/Scenarios/scenario/Scenario";
import {expect} from "Leaf.lspkg/Utils/common/Expect";
import {findSceneObjectByName, sleep} from "Leaf.lspkg/Utils/common/Utils";
import {findInteractableByName} from "Leaf.lspkg/Interactors/InteractableUtils";
import {WheelLeafInteractor} from "./WheelLeafInteractor";
import {KilnStation} from "../KilnStation";
import {WheelAudio} from "../WheelAudio";
import {WheelStudioUI} from "../WheelStudioUI";
import {Spin} from "../Spin";

/** Seconds to let the 6s firing sequence finish and reveal. */
const FIRE_SETTLE_S = 7.0;

function samePoint(a: vec3, b: vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function sameRotation(a: quat, b: quat): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
}

/** Do the pot's footprint and a plate's mesh bounds share any volume? */
function overlaps(potLo: vec3, potHi: vec3, lo: vec3, hi: vec3): boolean {
  return potLo.x < hi.x && potHi.x > lo.x &&
         potLo.y < hi.y && potHi.y > lo.y &&
         potLo.z < hi.z && potHi.z > lo.z;
}

@component
export class PingTestScenario extends Scenario {
  async run(): Promise<void> {
    await sleep(1200);

    const lathe = findSceneObjectByName("WHEEL Lathe");
    expect(lathe).not.toBe(null);
    const ui = findSceneObjectByName("WHEEL Studio UI");
    expect(ui).not.toBe(null);

    const kiln = ui.getComponent(KilnStation.getTypeName()) as KilnStation;
    const audio = ui.getComponent(WheelAudio.getTypeName()) as WheelAudio;
    const studio = ui.getComponent(WheelStudioUI.getTypeName()) as WheelStudioUI;
    expect(kiln).not.toBe(null);
    expect(audio).not.toBe(null);

    // The ping only rings a fired piece, and only a fired piece is placeable,
    // so both halves of this test need the kiln to have run.
    if (!kiln.isFired()) {
      kiln.fire();
      await sleep(FIRE_SETTLE_S * 1000);
    }
    expect(kiln.isFired()).toBe(true);

    // ── 1. A tap must ring the pot and move nothing ────────────────────────
    // The wheel spins an unplaced piece, so its rotation changes every frame on
    // its own. Park the spin for the measurement, or the assertion would be
    // testing the turntable rather than the ping.
    const spin = lathe.getComponent(Spin.getTypeName()) as Spin;
    const spinWasOn = spin ? spin.enabled : false;
    if (spin) spin.enabled = false;
    await sleep(120);

    const tr = lathe.getTransform();
    const posBefore = tr.getWorldPosition();
    const rotBefore = tr.getWorldRotation();
    const sclBefore = tr.getWorldScale();
    const pingsBefore = audio.pingCount;

    const interactor = new WheelLeafInteractor();
    const potTarget = findInteractableByName("WHEEL Lathe");
    expect(potTarget).not.toBe(null);
    // trigger() is press-and-release with no dwell and no travel: a tap.
    await interactor.trigger(potTarget);
    await sleep(600);

    const posAfter = tr.getWorldPosition();
    const rotAfter = tr.getWorldRotation();
    const sclAfter = tr.getWorldScale();

    expect(audio.pingCount).toBe(pingsBefore + 1);
    expect(samePoint(posBefore, posAfter)).toBe(true);
    expect(sameRotation(rotBefore, rotAfter)).toBe(true);
    expect(samePoint(sclBefore, sclAfter)).toBe(true);

    if (spin) spin.enabled = spinWasOn;

    print("[LEAF] PING tap rang the bell (" + pingsBefore + " -> " +
          audio.pingCount + ") and left the piece at " +
          posAfter.x.toFixed(4) + ", " + posAfter.y.toFixed(4) + ", " +
          posAfter.z.toFixed(4) + " — unchanged.");

    // ── 2. A tap on the GRAB capsule must not place either ─────────────────
    // This is the path that actually shipped the bug: PotPlacement bound
    // place() to onTriggerEnd on this collider, so the same tap that rang the
    // bell also dropped the piece. Tapping the lathe alone would not catch it.
    const grab = findInteractableByName("PotGrab");
    expect(grab).not.toBe(null);

    if (spin) spin.enabled = false;
    await sleep(120);
    const beforeGrabTap = tr.getWorldPosition();
    await interactor.trigger(grab);
    await sleep(600);
    const afterGrabTap = tr.getWorldPosition();
    expect(samePoint(beforeGrabTap, afterGrabTap)).toBe(true);
    if (spin) spin.enabled = spinWasOn;
    print("[LEAF] PING tap on the grab capsule left the piece at " +
          afterGrabTap.x.toFixed(4) + ", " + afterGrabTap.y.toFixed(4) + ", " +
          afterGrabTap.z.toFixed(4) + " — not placed.");

    // ── 3. A placement drag must land clear of every plate ─────────────────
    await interactor.drag(grab, new vec3(0, -6, 14), 800);
    await sleep(900);

    const placed = tr.getWorldPosition();
    // Same footprint the guard reasons about: the grab capsule's box.
    const potLo = new vec3(placed.x - 7, placed.y, placed.z - 7);
    const potHi = new vec3(placed.x + 7, placed.y + 22, placed.z + 7);

    const panels = studio.getPanelRoots();
    expect(panels.length).toBeGreaterThan(0);
    let worst = "";
    for (let i = 0; i < panels.length; i++) {
      const vis = panels[i].getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      if (!vis) continue;
      const lo = vis.worldAabbMin();
      const hi = vis.worldAabbMax();
      if (overlaps(potLo, potHi, lo, hi)) worst += panels[i].name + " ";
    }
    expect(worst).toBe("");

    print("[LEAF] PLACEMENT landed at " + placed.x.toFixed(1) + ", " +
          placed.y.toFixed(1) + ", " + placed.z.toFixed(1) +
          " — clear of all " + panels.length + " plates.");
  }
}
