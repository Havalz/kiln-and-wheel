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
/**
 * Ceiling on the pot's own incandescence. Held at 1 the glaze washes to near
 * white, and additive light has nowhere left to go - the heat rings laid over
 * it simply vanished. Capping it keeps the pot a saturated ember and leaves the
 * top of the range for the rings, which are what the eye is meant to follow.
 */
const GLOW_PEAK = 0.32;
/**
 * How far the glaze is dragged toward ember colour at peak heat. Clay in a kiln
 * goes deep red, not white - and a near-white pot leaves additive fire nowhere
 * to go, so the heat rings simply vanished against it. Darkening the vessel is
 * what makes the fire legible; the reveal animation restores the real glaze.
 */
const KILN_DARKEN = 0.88;
const EMBER_BOTTOM: [number, number, number, number] = [0.30, 0.07, 0.02, 1];
const EMBER_TOP: [number, number, number, number] = [0.54, 0.17, 0.04, 1];

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

  @input
  @hint("Hold the firing curve at holdHeat so the effect can be inspected or captured without racing the 6s sequence.")
  holdHeatNow: boolean = false;

  @input
  @hint("Heat value to hold, 0-1. Around 0.9 is the peak of the firing.")
  @widget(new SliderWidget(0, 1, 0.05))
  holdHeat: number = 0.9;
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
  private holding = false;

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
   * THE ONE CURVE. Normalised firing intensity, 0 when cold, 1 at the peak of
   * the hold. Every channel of the moment - ring spawn rate and brightness,
   * base bloom, the pot's glow, its tremble, and the audio level - reads this
   * and nothing keeps its own private clock. That is the whole reason it
   * exists: last time the particles ran on a boolean and the roar on its own
   * play(), so they drifted two seconds apart and the moment broke.
   */
  /**
   * CAPTURE AID. The firing is six seconds long and the editor's panel grab is
   * slower than that, so every attempt to photograph the effect landed after
   * the reveal. Holding the curve at a fixed value stops the clock without
   * faking anything: the rings, the pot's glow and its ember darkening all read
   * the same getHeat() they always do. Auto-clears when switched off.
   */
  getHeat(): number {
    if (this.holdHeatNow) {
      const v = this.holdHeat;
      return v < 0 ? 0 : v > 1 ? 1 : v;
    }
    if (!this.firing) return 0;
    const t = this.elapsed;
    if (t < PHASE_HEAT_END) {
      // Ease in rather than ramp linearly; a linear rise reads mechanical.
      const k = t / PHASE_HEAT_END;
      return k * k * (3 - 2 * k);
    }
    if (t < PHASE_PEAK_END) {
      // Hold, but breathing - fire surges and lulls rather than sitting flat.
      const k = (t - PHASE_HEAT_END) / (PHASE_PEAK_END - PHASE_HEAT_END);
      return 0.86 + 0.14 * Math.sin(k * Math.PI * 5.0);
    }
    if (t < PHASE_TOTAL) {
      const k = (t - PHASE_PEAK_END) / (PHASE_TOTAL - PHASE_PEAK_END);
      return 1 - k * k;   // falls away slowly at first, then drops
    }
    return 0;
  }

  /** Seconds since the firing began; 0 when not firing. */
  getElapsed(): number {
    return this.firing ? this.elapsed : 0;
  }

  /** Total length of the sequence, so followers need not re-declare it. */
  getDuration(): number {
    return PHASE_TOTAL;
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
    if (this.holdHeatNow) {
      if (!this.holding) {
        this.holding = true;
        if (!this.preFire) this.preFire = this.readMaterial();
        print("[Kiln] heat HELD at " + this.holdHeat.toFixed(2) +
              " - clear holdHeatNow to release.");
      }
      const h = this.getHeat();
      this.setGlow(h * GLOW_PEAK);
      this.darkenForHeat(h);
      return;
    }
    if (this.holding) {
      this.holding = false;
      this.setGlow(0);
      if (this.preFire) this.writeMaterial(this.preFire, this.preFire, 1);
    }

    if (this.runFireNow) {
      this.runFireNow = false;
      this.fire();
    }
    if (!this.firing) return;
    this.elapsed += getDeltaTime();
    const t = this.elapsed;

    // ONE CURVE. The glow is getHeat() and nothing else, so the pot breathes on
    // exactly the beat the rings do instead of running a second private clock.
    const heat = this.getHeat();
    this.setGlow(heat * GLOW_PEAK);
    this.darkenForHeat(heat);

    if (t >= PHASE_TOTAL) {
      this.reveal();
      return;
    }
    // Cooling ticks, once, as the curve turns over.
    if (t >= PHASE_PEAK_END && !this.playedTicks) {
      this.playedTicks = true;
      this.setEmbers(false);
      if (this.ticks) this.ticks.play(1);
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

  /** Drag the glaze toward ember as the heat curve rises. Same curve, no clock. */
  private darkenForHeat(heat: number): void {
    const p = this.glazeMaterial.mainPass as any;
    const k = heat * KILN_DARKEN;
    p.baseColorBottom = this.lerpColor(this.preFire.baseColorBottom, EMBER_BOTTOM, k);
    p.baseColorTop = this.lerpColor(this.preFire.baseColorTop, EMBER_TOP, k);
  }

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
