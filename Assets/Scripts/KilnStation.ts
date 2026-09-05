/**
 * WHEEL - KilnStation
 *
 * The 6-second firing. Press FIRE (or call fire() when the pot is released into
 * the kiln volume) and the pot is committed:
 *
 *   0.0-2.0s  firedGlow ramps 0 -> 1, embers rise, kiln roar fades in
 *   2.0-4.0s  peak glow, the pot is barely readable through the heat
 *   4.0-6.0s  cooling, glow falls to 0, embers die, cooling ticks
 *   6.0s      REVEAL - the transformed glaze, state becomes FIRED
 *
 * The transformation is seeded (see FiringSeed): the seed is derived from the
 * silhouette, the glaze name and the moment of firing, then stored on the piece.
 * The same seed always reproduces the same pot; no two firings match.
 *
 * After firing the piece is finished: handles hide and the wheel controls lock.
 */

import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event";

import {WheelStudioUI} from "./WheelStudioUI";
import {LatheMesher} from "./core/LatheMesher";
import {ProfileHandles} from "./core/ProfileHandles";
import {deriveSeed, fireGlaze} from "./core/FiringSeed";
import type {Bloom, FiringResult} from "./core/FiringSeed";
import type {GlazeParams} from "./core/GlazePresets";

const PHASE_HEAT_END = 2.0;
const PHASE_PEAK_END = 4.0;
const PHASE_TOTAL = 6.0;

@component
export class KilnStation extends BaseScriptComponent {
  @ui.label("Kiln — 6s firing")
  @ui.separator
  @input ui: WheelStudioUI;
  @input glazeMaterial: Material;
  @input mesher: LatheMesher;
  @input @allowUndefined handles: ProfileHandles;

  @ui.group_start("Editor trigger (no pinch in preview)")
  @input
  @hint("Tick to run the firing sequence now — the simulator stand-in for pressing FIRE. Auto-clears.")
  runFireNow: boolean = false;
  @ui.group_end

  @ui.group_start("Ember VFX")
  @input
  @allowUndefined
  @hint("SceneObject holding the ember VFXComponent. Enabled for the heat and peak phases only.")
  emberVfx: SceneObject;
  @ui.group_end

  @ui.group_start("Audio")
  @input @allowUndefined @hint("6s gas-furnace roar.") kilnRoarTrack: AudioTrackAsset;
  @input @allowUndefined @hint("Sparse dry pops during heat and peak.") emberCrackleTrack: AudioTrackAsset;
  @input @allowUndefined @hint("Metallic contraction ticks during cooling.") coolingTickTrack: AudioTrackAsset;
  @input @allowUndefined @hint("Warm ceramic ping at the reveal.") revealChimeTrack: AudioTrackAsset;
  @ui.group_end

  private _onFired = new Event<FiringResult>();
  /** Fires once at the reveal, carrying the seed and the transformed glaze. */
  get onFired(): PublicApi<FiringResult> { return this._onFired.publicApi(); }

  /** Seed of the firing that produced the current piece, 0 until fired. */
  private storedSeed = 0;
  private result: FiringResult = null;

  private firing = false;
  private fired = false;
  private elapsed = 0;
  private preFire: GlazeParams = null;

  private roar: AudioComponent = null;
  private embers: AudioComponent = null;
  private ticks: AudioComponent = null;
  private chime: AudioComponent = null;
  private playedTicks = false;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.ui || !this.glazeMaterial || !this.mesher) {
      print("[Kiln] inputs not assigned - station inert.");
      return;
    }
    this.roar = this.makeAudio(this.kilnRoarTrack);
    this.embers = this.makeAudio(this.emberCrackleTrack);
    this.ticks = this.makeAudio(this.coolingTickTrack);
    this.chime = this.makeAudio(this.revealChimeTrack);
    this.setEmbers(false);
    this.ui.setKilnState("COLD");
    this.ui.onFire.add(() => this.fire());
  }

  private makeAudio(track: AudioTrackAsset): AudioComponent {
    if (!track) return null;
    // AudioTrackAsset cannot be created at runtime, so the tracks arrive as
    // @inputs and only the AudioComponents are built here.
    const a = this.sceneObject.createComponent("Component.AudioComponent") as AudioComponent;
    a.audioTrack = track;
    return a;
  }

  private setEmbers(on: boolean): void {
    if (this.emberVfx) this.emberVfx.enabled = on;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /** Seed of the piece currently on the wheel. 0 before it has been fired. */
  getSeed(): number {
    return this.storedSeed;
  }

  isFired(): boolean {
    return this.fired;
  }

  /**
   * Commit the piece. Called by the FIRE button, and the entry point for
   * releasing the pot into the kiln volume.
   */
  fire(): void {
    if (this.firing || this.fired) return;

    this.firing = true;
    this.elapsed = 0;
    this.playedTicks = false;
    this.preFire = this.readMaterial();

    // The seed is drawn ONCE, here, and kept. Everything the kiln does to this
    // piece is a pure function of it, so the result is reproducible forever.
    const profile = this.mesher.getModel().serialize();
    const glazeName = this.ui.getGlazeName();
    this.storedSeed = deriveSeed(profile, glazeName, Date.now());
    this.result = fireGlaze(this.preFire, this.storedSeed);

    print("[Kiln] firing seed=" + this.storedSeed + " -> " + this.result.summary);
    this.ui.setKilnState("FIRING");
    this.ui.setKilnStatus("Firing…");

    this.setEmbers(true);
    if (this.roar) this.roar.play(1);
    if (this.embers) this.embers.play(1);
  }

  // ── Sequence ──────────────────────────────────────────────────────────────

  private onUpdate(): void {
    if (this.runFireNow) {
      this.runFireNow = false;
      this.fire();
    }
    if (!this.firing) return;
    this.elapsed += getDeltaTime();
    const t = this.elapsed;

    if (t < PHASE_HEAT_END) {
      // Heat: glow ramps in.
      this.setGlow(t / PHASE_HEAT_END);
    } else if (t < PHASE_PEAK_END) {
      // Peak: held at full, pot barely readable through the heat.
      this.setGlow(1);
    } else if (t < PHASE_TOTAL) {
      // Cooling.
      const k = (t - PHASE_PEAK_END) / (PHASE_TOTAL - PHASE_PEAK_END);
      this.setGlow(1 - k);
      if (!this.playedTicks) {
        this.playedTicks = true;
        this.setEmbers(false);
        if (this.ticks) this.ticks.play(1);
      }
    } else {
      this.reveal();
    }
  }

  private reveal(): void {
    this.firing = false;
    this.fired = true;
    this.setGlow(0);
    this.setEmbers(false);
    if (this.chime) this.chime.play(1);

    // Ease the transformed glaze in rather than snapping, so the reveal reads
    // as the pot cooling into its final colour.
    const from = this.preFire;
    const to = this.result.params;
    animate({
      duration: 0.8,
      easing: "ease-out-quad",
      update: (k: number) => this.writeMaterial(from, to, k),
      ended: () => {
        this.writeMaterial(from, to, 1);
        this.applyBlooms(this.result.blooms);
      }
    });

    this.ui.setKilnState("FIRED");
    // "#seed · summary" rather than "Seed N — summary": the panel is 13cm wide
    // and every character saved is one the wrap does not have to spend.
    this.ui.setKilnStatus("#" + this.storedSeed + " · " + this.result.summary);
    print("[Kiln] REVEAL seed=" + this.storedSeed + " " + this.result.summary);

    // The piece is finished: it can no longer be reshaped.
    this.lockPiece();
    this._onFired.invoke(this.result);
  }

  /**
   * A fired pot is a finished object. Handles disappear and the wheel controls
   * stop responding - reshaping fired clay is not a thing.
   */
  private lockPiece(): void {
    if (this.handles) this.handles.setEditable(false);
    this.ui.setWheelControlsEnabled(false);
  }

  private applyBlooms(blooms: Bloom[]): void {
    const p = this.glazeMaterial.mainPass as any;
    // Three bloom slots; unused ones carry zero intensity.
    for (let i = 0; i < 3; i++) {
      const b: Bloom = i < blooms.length ? blooms[i] : null;
      const v = b
        ? new vec4(b.height, b.angle, b.size, b.intensity)
        : new vec4(0, 0, 0, 0);
      if (i === 0) p.bloomA = v;
      else if (i === 1) p.bloomB = v;
      else p.bloomC = v;
    }
  }

  // ── Material ──────────────────────────────────────────────────────────────

  private setGlow(v: number): void {
    (this.glazeMaterial.mainPass as any).firedGlow = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private lerpColor(a: number[], b: number[], t: number): vec4 {
    return new vec4(this.lerp(a[0], b[0], t), this.lerp(a[1], b[1], t),
                    this.lerp(a[2], b[2], t), this.lerp(a[3], b[3], t));
  }

  private writeMaterial(from: GlazeParams, to: GlazeParams, t: number): void {
    const p = this.glazeMaterial.mainPass as any;
    p.baseColorBottom = this.lerpColor(from.baseColorBottom, to.baseColorBottom, t);
    p.baseColorTop = this.lerpColor(from.baseColorTop, to.baseColorTop, t);
    p.rimTint = this.lerpColor(from.rimTint, to.rimTint, t);
    p.crackleIntensity = this.lerp(from.crackleIntensity, to.crackleIntensity, t);
    p.dripAmount = this.lerp(from.dripAmount, to.dripAmount, t);
  }

  private c4(v: any, f: number[]): [number, number, number, number] {
    if (!v) return [f[0], f[1], f[2], f[3]];
    return [v.r !== undefined ? v.r : v.x, v.g !== undefined ? v.g : v.y,
            v.b !== undefined ? v.b : v.z, v.a !== undefined ? v.a : v.w];
  }

  private readMaterial(): GlazeParams {
    const p = this.glazeMaterial.mainPass as any;
    return {
      baseColorBottom: this.c4(p.baseColorBottom, [0.62, 0.72, 0.66, 1]),
      baseColorTop: this.c4(p.baseColorTop, [0.82, 0.90, 0.86, 1]),
      roughness: p.roughness !== undefined ? p.roughness : 0.45,
      metallic: p.metallic !== undefined ? p.metallic : 0,
      crackleScale: p.crackleScale !== undefined ? p.crackleScale : 7,
      crackleIntensity: p.crackleIntensity !== undefined ? p.crackleIntensity : 0.22,
      dripAmount: p.dripAmount !== undefined ? p.dripAmount : 0.4,
      rimTint: this.c4(p.rimTint, [1, 0.86, 0.62, 0.55]),
      glossBands: p.glossBands !== undefined ? p.glossBands : 0.35,
      firedGlow: 0
    };
  }
}
