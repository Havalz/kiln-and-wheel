/**
 * WHEEL - GlazeBenchVoice
 *
 * Hold the mic on the Glaze Bench, describe a glaze, release. The transcript
 * goes to Gemini through the Remote Service Gateway, comes back as JSON, is
 * clamped into legal range, and eases onto GlazeMat over 1.2s. WET -> GLAZED.
 *
 * THE TOOL MUST NEVER DEAD-END ON THE NETWORK.
 * Every failure path -- timeout, transport error, refusal, unparseable reply --
 * lands on the closest local preset by keyword and says so on the panel. The
 * 20s timeout is enforced here, not by the gateway, because Gemini.models()
 * exposes no timeout of its own: a hung request would otherwise leave the bench
 * stuck on "Thinking" forever.
 *
 * EDITOR PATH: ASR needs a device mic. Type into `typedGlaze` in the Inspector
 * and the same Gemini -> clamp -> apply pipeline runs, so the flow is
 * demonstrable in the simulator.
 */

import {Gemini} from "RemoteServiceGateway.lspkg/HostedExternal/Gemini";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";

import {WheelStudioUI} from "./WheelStudioUI";
import {
  GLAZE_SYSTEM_INSTRUCTION,
  GlazeCache,
  offlineGlaze,
  parseGlazeReply
} from "./core/GlazeSchema";
import type {GlazeResult} from "./core/GlazeSchema";
import type {GlazeParams} from "./core/GlazePresets";
import {frameRms} from "./core/VoiceEnvelope";

/**
 * ASR reports a status code. A code is not a sentence, and the panel is the
 * one place the wearer can read - so each code becomes something they can act
 * on, with the code left for the Logger.
 */
function micMessage(code: any): string {
  const c = String(code);
  if (c.indexOf("NoInternet") >= 0) return "No connection — pick a glaze by hand.";
  if (c.indexOf("Unauthenticated") >= 0) return "Voice sign-in expired — pick a glaze by hand.";
  return "The microphone isn't available — pick a glaze by hand.";
}

/** Sprite capacity and cadence for the mic pulse. */
const MIC_FRAME_CAPACITY = 2048;
const MIC_FRAMES_PER_UPDATE = 64;
/** Seconds without a single audio frame before the mic is called dead. */
const MIC_GRACE_S = 1.0;
const RING_COUNT = 6;
const CORE_CM = 2.9;

/**
 * THREE BEATS OF ONE GESTURE. Speaking, working and resolving are phases of a
 * single animation, not three animations that replace one another: every ring
 * carries a size, an orbit radius and an alpha which are EASED toward whatever
 * the current beat wants. Nothing is ever destroyed at a phase change, so the
 * halo you left behind on release is the same halo that collapses into the
 * orbit, and the same one that blooms outward when the glaze lands.
 */
const PH_IDLE = 0;
const PH_SPEAK = 1;
const PH_WORK = 2;
const PH_RESOLVE = 3;

// Beat 1 - speaking: rings leave the core and fade outward.
const SPEAK_SPAWN_S = 0.2;
const SPEAK_RING_START_CM = 3.0;
const SPEAK_RING_END_CM = 8.6;
const SPEAK_RING_TTL = 0.75;
// Beat 2 - working: they collapse to small dots and circle the core.
const ORBIT_R_CM = 2.7;
const ORBIT_DOT_CM = 1.25;
const ORBIT_SPEED = 2.0;
// Beat 3 - resolving: they bloom outward and go.
const BLOOM_R_CM = 5.4;
const BLOOM_DOT_CM = 3.2;
const RESOLVE_S = 0.55;
/** Last-resort guard so the working beat can never spin forever. */
const WORK_HARD_LIMIT_PAD_S = 6.0;

/**
 * Attack and release for the level follower, in seconds. Fast attack so a
 * syllable snaps the core alive on the frame it lands; slower release so it
 * settles instead of strobing between glottal pulses.
 */
const LEVEL_ATTACK_S = 0.02;
const LEVEL_RELEASE_S = 0.18;
/**
 * Below this the input is treated as room tone and shaped to zero. Silence has
 * to look plainly dead, not just slightly smaller than speech.
 */
const LEVEL_GATE = 0.035;

class PulseRing {
  obj: SceneObject = null;
  mat: Material = null;
  tr: Transform = null;
  alive = false;
  size = 0;
  sizeTarget = 0;
  orbitR = 0;
  orbitTarget = 0;
  angle = 0;
  spin = ORBIT_SPEED;
  alpha = 0;
  alphaTarget = 0;
  ttl = 0;
}

@component
export class GlazeBenchVoice extends BaseScriptComponent {
  @ui.label("Glaze Bench — voice to glaze")
  @ui.separator
  @input
  @hint("The WHEEL Studio UI panel that owns the Glaze Bench.")
  ui: WheelStudioUI;

  @input
  @hint("GlazeMat material applied to the lathe.")
  glazeMaterial: Material;

  @ui.group_start("Editor fallback (no mic in preview)")
  @input
  @hint("Type a glaze description here, then tick Run Typed Glaze. Runs the identical Gemini path as speaking.")
  typedGlaze: string = "a dark iron tenmoku that breaks rust at the rim";

  @input
  @hint("Tick to send the typed description on the next frame. Auto-clears.")
  runTypedGlaze: boolean = false;
  @ui.group_end

  @ui.group_start("Live mic pulse")
  @input
  @allowUndefined
  @hint("Microphone AudioTrackAsset. ASR returns transcripts, never levels, so the pulse needs its own source. Without it the pulse is skipped and the No-microphone state stands.")
  microphone: AudioTrackAsset;

  @input
  @allowUndefined
  @hint("Unlit ADDITIVE material with ENABLE_BASE_TEX on (HeatRingMat works). Without it the pulse is built but never drawn.")
  pulseMaterial: Material;

  @input
  @hint("Mic core colour. Bright and saturated: on the waveguide it has to add light.")
  @widget(new ColorWidget())
  micColor: vec4 = new vec4(0.42, 1.0, 0.86, 1.0);

  @input
  @hint("Colour of the rings radiating out from the mic.")
  @widget(new ColorWidget())
  ringColor: vec4 = new vec4(0.30, 0.86, 1.0, 1.0);

  @input
  @hint("Multiplies raw microphone RMS before shaping. Raw levels sit near zero; this puts speech across the usable range. Raise if the core barely moves, lower if it pins wide open.")
  @widget(new SliderWidget(1, 40, 0.5))
  micSensitivity: number = 12;

  @input
  @hint("Hold the pulse on screen so a beat can be inspected or captured without speaking. Listening clears it.")
  holdPulseNow: boolean = false;

  @input
  @hint("Which beat to hold: 1 speaking, 2 working, 3 resolving.")
  @widget(new SliderWidget(1, 3, 1))
  holdBeat: number = 1;
  @ui.group_end

  @ui.group_start("Model")
  @input
  @hint("Gemini model id. Known-good through RSG: gemini-2.0-flash, gemini-2.5-flash, gemini-2.5-pro.")
  geminiModel: string = "gemini-2.5-flash";

  @input
  @hint("Hard timeout in seconds. On expiry the bench falls back to a local preset rather than hanging.")
  @widget(new SliderWidget(5, 60, 1))
  timeoutSeconds: number = 20;

  @input
  @hint("Seconds for the glaze to ease onto the vessel.")
  @widget(new SliderWidget(0.1, 4, 0.1))
  transitionSeconds: number = 1.2;
  @ui.group_end

  private asrModule: AsrModule = require("LensStudio:AsrModule");
  private readonly cache = new GlazeCache(32);

  private isListening = false;
  private isThinking = false;
  private latestTranscript = "";
  private timedOut = false;

  /** Params currently on the material, the start point of the next transition. */
  private current: GlazeParams = null;

  private provider: any = null;
  private micFrame = new Float32Array(MIC_FRAME_CAPACITY);
  private sawAudio = false;
  private listenElapsed = 0;
  private level = 0;
  private pulseRoot: SceneObject = null;
  private coreObj: SceneObject = null;
  private coreMat: Material = null;
  private rings: PulseRing[] = [];
  private nextRing = 0;
  private phase = PH_IDLE;
  private phaseT = 0;
  private holding = false;
  private statusTick = 0;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => {
      this.pollTypedTrigger();
      this.updatePulse(getDeltaTime());
    });
  }

  private onStart(): void {
    if (!this.ui || !this.glazeMaterial) {
      print("[Glaze] ui or glazeMaterial not assigned - bench inert.");
      return;
    }
    this.current = this.readMaterial();
    this.ui.setGlazeState("WET");
    this.ui.onGlazeMicDown.add(() => this.startListening());
    this.ui.onGlazeMicUp.add(() => this.stopListening());

    // ASR hands back transcripts, never levels, so the pulse reads the
    // microphone directly. If that asset is absent the pulse stays dark and the
    // panel falls back to the No-microphone state rather than faking life.
    if (this.microphone) {
      this.provider = this.microphone.control as any;
    } else {
      print("[Glaze] no microphone asset assigned - mic pulse disabled.");
    }
    this.buildPulse();
  }

  /** Inspector checkbox is the editor's stand-in for a mic press. */
  private pollTypedTrigger(): void {
    if (!this.runTypedGlaze) return;
    this.runTypedGlaze = false;
    const text = (this.typedGlaze || "").trim();
    if (text.length === 0) {
      this.ui.setGlazeStatus("Type a glaze description first.");
      return;
    }
    print("[Glaze] typed path: \"" + text + "\"");
    this.ui.setGlazeTranscript(text);
    this.requestGlaze(text);
  }

  // ── ASR ───────────────────────────────────────────────────────────────────

  // ── Live mic pulse ────────────────────────────────────────────────────────

  /**
   * CONFIDENCE, NOT MEASUREMENT. Loudness has no effect on the glaze, so this
   * is not a meter - its only job is to make "the microphone is hearing you"
   * unmistakable. A core that swells and brightens with your voice, and rings
   * that leave it as you speak and die away when you stop, answer that in a
   * glance. A static word cannot: it looks identical whether the mic is live
   * or denied, which is exactly why people hesitate and restart.
   */
  private buildPulse(): void {
    const anchor = this.ui ? this.ui.getGlazeMicAnchor() : null;
    if (!anchor) {
      print("[Glaze] no mic anchor from the UI - pulse skipped.");
      return;
    }
    this.pulseRoot = global.scene.createSceneObject("MicPulse");
    this.pulseRoot.setParent(anchor);
    this.pulseRoot.layer = anchor.layer;

    const disc = this.makeSprite(64, false);
    const ring = this.makeSprite(64, true);

    this.coreObj = this.makeQuad("MicCore", disc, this.micColor);
    this.coreMat = this.lastMat;

    for (let i = 0; i < RING_COUNT; i++) {
      const r = new PulseRing();
      r.obj = this.makeQuad("MicRing_" + i, ring, this.ringColor);
      r.mat = this.lastMat;
      r.tr = r.obj.getTransform();
      r.obj.enabled = false;
      this.rings.push(r);
    }
    this.setPulseVisible(false);
  }

  private lastMat: Material = null;

  /** Unit quad centred on its origin, so scaling grows it from the middle. */
  private makeQuad(name: string, tex: Texture, color: vec4): SceneObject {
    const b = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    b.topology = MeshTopology.Triangles;
    b.indexType = MeshIndexType.UInt16;
    b.appendVerticesInterleaved([
      -0.5, -0.5, 0,  0, 0, 1,  0, 0,
       0.5, -0.5, 0,  0, 0, 1,  1, 0,
      -0.5,  0.5, 0,  0, 0, 1,  0, 1,
       0.5,  0.5, 0,  0, 0, 1,  1, 1
    ]);
    b.appendIndices([0, 1, 2, 2, 1, 3]);
    b.updateMesh();   // commit, or the mesh reports empty and draws nothing

    const o = global.scene.createSceneObject(name);
    o.setParent(this.pulseRoot);
    o.layer = this.pulseRoot.layer;
    const v = o.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    v.mesh = b.getMesh();
    this.lastMat = null;
    if (this.pulseMaterial) {
      const m = this.pulseMaterial.clone();
      const pass = m.mainPass as any;
      pass.baseTex = tex;
      pass.baseColor = color;
      v.clearMaterials();
      v.addMaterial(m);
      this.lastMat = m;
    }
    return o;
  }

  /**
   * Soft disc, or soft annulus when `hollow`. Both reach exactly zero at the
   * rim, so nothing in the pulse ever shows an edge.
   */
  private makeSprite(px: number, hollow: boolean): Texture {
    const tex = ProceduralTextureProvider.create(px, px, Colorspace.RGBA);
    const provider = tex.control as ProceduralTextureProvider;
    const data = new Uint8Array(px * px * 4);
    const c = (px - 1) / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = (x - c) / c;
        const dy = (y - c) / c;
        const d = Math.sqrt(dx * dx + dy * dy);
        let f: number;
        if (hollow) {
          // A band peaking at 0.72 of the radius, zero at centre and rim.
          const band = 1 - Math.min(1, Math.abs(d - 0.72) / 0.26);
          f = band * band * (3 - 2 * band);
        } else {
          const t = Math.max(0, 1 - d);
          f = t * t * (3 - 2 * t);
          f = f * f;
        }
        if (f < 0) f = 0;
        const v = Math.round(Math.min(1, f) * 255);
        const i = (y * px + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = v;
      }
    }
    provider.setPixels(0, 0, px, px, data);
    return tex;
  }

  /** DRAIN the mic, do not sip: one read per update starves the level. */
  private pumpMic(): void {
    if (!this.provider || !this.provider.getAudioFrame) return;
    for (let guard = 0; guard < MIC_FRAMES_PER_UPDATE; guard++) {
      let shape: any = null;
      try {
        shape = this.provider.getAudioFrame(this.micFrame);
      } catch (e) {
        return;
      }
      const count = shape && isFinite(shape.x) ? Math.floor(shape.x) : 0;
      if (count <= 0) return;
      this.sawAudio = true;
      const rms = frameRms(this.micFrame, count);
      // Fast attack, slower release: the core is alive on the frame a syllable
      // lands, then settles rather than chattering between glottal pulses.
      const rate = rms > this.level ? 1 / LEVEL_ATTACK_S : 1 / LEVEL_RELEASE_S;
      this.level = this.ease(this.level, rms, rate, getDeltaTime());
    }
  }

  private updatePulse(dt: number): void {
    if (!this.pulseRoot) return;

    if (this.holdPulseNow) {
      if (!this.holding) {
        this.holding = true;
        this.setPulseVisible(true);
        this.phase = this.holdBeat < 2 ? PH_SPEAK : this.holdBeat < 3 ? PH_WORK : PH_RESOLVE;
        this.phaseT = this.phase === PH_RESOLVE ? RESOLVE_S * 0.35 : 1.0;
        this.level = 0.62;
        this.seedHold();
        print("[Glaze] mic pulse HELD at beat " + this.holdBeat +
              " - clear holdPulseNow to release.");
      }
      // Resolving is a transient: pin its clock so the bloom can be looked at.
      if (this.phase === PH_RESOLVE) this.phaseT = RESOLVE_S * 0.35;
      else this.phaseT += dt;
      this.driveBeat(dt, 0.62);
      return;
    }
    if (this.holding) {
      this.holding = false;
      this.phase = PH_IDLE;
      this.setPulseVisible(false);
      return;
    }

    if (this.phase === PH_IDLE) return;
    this.phaseT += dt;

    if (this.phase === PH_SPEAK) {
      this.listenElapsed += dt;
      this.pumpMic();
      // NO FAKE LIFE. Without a single frame nothing animates and the panel
      // says so - an indicator that moves on a dead mic actively misleads.
      if (!this.sawAudio) {
        if (this.listenElapsed >= MIC_GRACE_S) {
          this.phase = PH_IDLE;
          this.setPulseVisible(false);
          this.ui.setGlazeStatus("No microphone");
        }
        return;
      }
      this.decayLevel(dt);
    } else if (this.phase === PH_WORK) {
      this.tickThinkingStatus(dt);
      // The working beat can never outlive the request it is waiting on.
      if (this.phaseT > this.timeoutSeconds + WORK_HARD_LIMIT_PAD_S) {
        print("[Glaze] pulse watchdog - resolving a working beat that outlived its request.");
        this.enterResolve();
      }
    } else if (this.phase === PH_RESOLVE && this.phaseT >= RESOLVE_S) {
      this.phase = PH_IDLE;
      this.setPulseVisible(false);
      return;
    }

    this.driveBeat(dt, this.shapedLevel());
  }

  // ── Beats ─────────────────────────────────────────────────────────────────

  /** Release: the halo stops radiating and becomes the orbit. Nothing is destroyed. */
  private enterWork(): void {
    this.phase = PH_WORK;
    this.phaseT = 0;
    this.statusTick = 99;
    let live = 0;
    for (let i = 0; i < this.rings.length; i++) if (this.rings[i].alive) live++;
    // Top the orbit up from the pool so it reads as a ring of dots, and let the
    // new ones start at the core so they collapse inward like the rest.
    for (let i = 0; i < this.rings.length && live < RING_COUNT; i++) {
      const r = this.rings[i];
      if (r.alive) continue;
      r.alive = true;
      r.obj.enabled = true;
      r.size = SPEAK_RING_START_CM;
      r.orbitR = 0;
      r.alpha = 0.5;
      live++;
    }
    let n = 0;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      if (!r.alive) continue;
      r.ttl = -1;                                   // no longer dies of age
      r.angle = (n / Math.max(1, live)) * Math.PI * 2;
      r.spin = ORBIT_SPEED * (0.85 + Math.random() * 0.4);
      n++;
    }
  }

  /** The glaze has landed: one bloom outward, then gone. */
  private enterResolve(): void {
    if (this.phase === PH_IDLE) return;
    this.phase = PH_RESOLVE;
    this.phaseT = 0;
  }

  /** Ease every ring toward what the current beat wants. */
  private driveBeat(dt: number, level: number): void {
    if (this.phase === PH_SPEAK) {
      this.spawnRings(dt, level);
      this.driveCoreSpeaking(level);
    } else if (this.phase === PH_WORK) {
      this.driveCoreWorking();
    } else if (this.phase === PH_RESOLVE) {
      this.driveCoreResolving();
    }

    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      if (!r.alive) continue;

      if (this.phase === PH_SPEAK) {
        r.sizeTarget = SPEAK_RING_END_CM;
        r.orbitTarget = 0;
        r.alphaTarget = 0;
        if (r.ttl >= 0) {
          r.ttl -= dt;
          if (r.ttl <= 0) { r.alive = false; r.obj.enabled = false; continue; }
        }
      } else if (this.phase === PH_WORK) {
        r.sizeTarget = ORBIT_DOT_CM;
        r.orbitTarget = ORBIT_R_CM;
        r.alphaTarget = 0.9;
        r.angle += r.spin * dt;
      } else {
        r.sizeTarget = BLOOM_DOT_CM;
        r.orbitTarget = BLOOM_R_CM;
        r.angle += r.spin * 0.4 * dt;
      }

      const rate = this.phase === PH_SPEAK ? 3.2 : this.phase === PH_WORK ? 5.0 : 7.5;
      r.size = this.ease(r.size, r.sizeTarget, rate, dt);
      r.orbitR = this.ease(r.orbitR, r.orbitTarget, rate, dt);
      if (this.phase === PH_RESOLVE) {
        // Alpha is driven by the beat clock, not eased toward zero: easing let
        // the rings fade out well before they had travelled anywhere, so the
        // bloom was over before it was visible. Now they stay lit while they
        // open and only give out at the very end.
        const k = Math.min(1, this.phaseT / RESOLVE_S);
        r.alpha = Math.pow(1 - k, 1.4);
      } else {
        r.alpha = this.ease(r.alpha, r.alphaTarget,
          this.phase === PH_SPEAK ? 2.6 : 4.0, dt);
      }

      r.tr.setLocalScale(new vec3(r.size, r.size, 1));
      r.tr.setLocalPosition(new vec3(
        Math.cos(r.angle) * r.orbitR, Math.sin(r.angle) * r.orbitR, 0.02));
      if (r.mat) {
        const c = this.ringColor;
        const a = r.alpha < 0 ? 0 : r.alpha;
        (r.mat.mainPass as any).baseColor =
          new vec4(c.x * a, c.y * a, c.z * a, c.w * a);
      }
    }
  }

  private ease(cur: number, target: number, rate: number, dt: number): number {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  private driveCoreSpeaking(level: number): void {
    this.writeCore(CORE_CM * (0.5 + 1.15 * level), 0.2 + 2.1 * level);
  }

  /**
   * A slow, even breath - deliberately NOT input-shaped. Working has to look
   * like work, not like it is still listening to a room that has gone quiet.
   */
  private driveCoreWorking(): void {
    const b = 0.5 + 0.5 * Math.sin(this.phaseT * 3.2);
    this.writeCore(CORE_CM * (0.78 + 0.22 * b), 1.15 + 0.85 * b);
  }

  private driveCoreResolving(): void {
    const k = Math.min(1, this.phaseT / RESOLVE_S);
    this.writeCore(CORE_CM * (0.9 + 1.7 * k), (1 - k) * 2.0);
  }

  private writeCore(scale: number, gain: number): void {
    if (!this.coreObj) return;
    this.coreObj.getTransform().setLocalScale(new vec3(scale, scale, 1));
    if (this.coreMat) {
      const c = this.micColor;
      (this.coreMat.mainPass as any).baseColor =
        new vec4(c.x * gain, c.y * gain, c.z * gain, c.w);
    }
  }

  /** Countdown, not a frozen word: it says work is happening AND how long is left. */
  private tickThinkingStatus(dt: number): void {
    this.statusTick += dt;
    if (this.statusTick < 0.25) return;
    this.statusTick = 0;
    const left = Math.max(0, Math.ceil(this.timeoutSeconds - this.phaseT));
    this.ui.setGlazeStatus("Thinking… " + left + "s");
  }

  private seedHold(): void {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.alive = true;
      r.obj.enabled = true;
      r.ttl = this.phase === PH_SPEAK ? SPEAK_RING_TTL : -1;
      r.angle = (i / this.rings.length) * Math.PI * 2;
      r.spin = ORBIT_SPEED;
      if (this.phase === PH_SPEAK) {
        r.size = SPEAK_RING_START_CM + (SPEAK_RING_END_CM - SPEAK_RING_START_CM) * (i / this.rings.length);
        r.orbitR = 0;
        r.alpha = 1 - i / this.rings.length;
      } else if (this.phase === PH_WORK) {
        r.size = ORBIT_DOT_CM;
        r.orbitR = ORBIT_R_CM;
        r.alpha = 0.9;
      } else {
        r.size = BLOOM_DOT_CM * 0.6;
        r.orbitR = BLOOM_R_CM * 0.45;
        r.alpha = 0.6;
      }
    }
  }

  // ── Level follower ────────────────────────────────────────────────────────

  /**
   * Between microphone frames the follower still has to fall, or a single loud
   * syllable would leave the core parked bright through the silence after it.
   */
  private decayLevel(dt: number): void {
    this.level = this.ease(this.level, 0, 1 / LEVEL_RELEASE_S, dt);
  }

  /**
   * Gate, then expand. Raw RMS spends its whole life in a narrow band near
   * zero, so mapping it straight to scale makes speech and silence look nearly
   * identical. Subtracting the gate and re-expanding pushes room tone to a hard
   * zero and speech across most of the range.
   */
  private shapedLevel(): number {
    const g = (this.level * this.micSensitivity - LEVEL_GATE) / (1 - LEVEL_GATE);
    if (g <= 0) return 0;
    return Math.pow(g > 1 ? 1 : g, 0.65);
  }

  private spawnRings(dt: number, level: number): void {
    if (level < 0.08) return;         // silence emits nothing at all
    this.nextRing -= dt * (0.5 + 2.0 * level);
    if (this.nextRing > 0) return;
    this.nextRing = SPEAK_SPAWN_S;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      if (r.alive) continue;
      r.alive = true;
      r.obj.enabled = true;
      r.size = SPEAK_RING_START_CM;
      r.orbitR = 0;
      r.angle = Math.random() * Math.PI * 2;
      r.alpha = 0.95;
      r.ttl = SPEAK_RING_TTL;
      return;
    }
  }

  private setPulseVisible(on: boolean): void {
    if (this.pulseRoot) this.pulseRoot.enabled = on;
    if (!on) {
      for (let i = 0; i < this.rings.length; i++) {
        this.rings[i].alive = false;
        if (this.rings[i].obj) this.rings[i].obj.enabled = false;
      }
    }
  }

  private startListening(): void {
    if (this.isListening || this.isThinking) return;
    this.isListening = true;
    this.sawAudio = false;
    this.listenElapsed = 0;
    this.level = 0;
    this.phase = PH_SPEAK;
    this.phaseT = 0;
    this.setPulseVisible(true);
    if (this.provider && this.provider.start) {
      try { this.provider.start(); } catch (e) { print("[Glaze] mic start failed: " + e); }
    }
    this.latestTranscript = "";
    this.ui.setGlazeTranscript("");
    this.ui.setGlazeStatus("Listening… release to stop");
    print("[Glaze] mic down");

    // Options come from the AsrModule NAMESPACE, not the required instance -
    // the statics do not exist on the instance and fail silently there.
    const opts = AsrModule.AsrTranscriptionOptions.create();
    opts.mode = AsrModule.AsrMode.HighAccuracy;
    opts.silenceUntilTerminationMs = 1200;

    opts.onTranscriptionUpdateEvent.add((e: AsrModule.TranscriptionUpdateEvent) => {
      if (e.text && e.text.length > 0) {
        this.latestTranscript = e.text;
        // Write partials live so the user can see they are being heard.
        this.ui.setGlazeTranscript(e.text);
      }
      print("[Glaze] ASR partial=\"" + e.text + "\" final=" + e.isFinal);
    });

    opts.onTranscriptionErrorEvent.add((code: AsrModule.AsrStatusCode) => {
      print("[Glaze] ASR error code=" + code);
      this.isListening = false;
      this.ui.setGlazeStatus(micMessage(code));
    });

    try {
      this.asrModule.startTranscribing(opts);
    } catch (e) {
      this.isListening = false;
      print("[Glaze] startTranscribing threw: " + e);
      this.ui.setGlazeStatus("Mic unavailable. Use the typed field.");
    }
  }

  private stopListening(): void {
    if (!this.isListening) return;
    this.isListening = false;
    if (this.provider && this.provider.stop) {
      try { this.provider.stop(); } catch (e) { print("[Glaze] mic stop failed: " + e); }
    }
    // The halo does not stop and get replaced - it becomes the orbit, and the
    // orbit becomes the bloom when the glaze lands. One gesture, three beats.
    if (this.sawAudio) this.enterWork();
    else this.setPulseVisible(false);
    print("[Glaze] mic up");
    this.asrModule.stopTranscribing().then(() => {
      const text = this.latestTranscript.trim();
      if (text.length === 0) {
        this.enterResolve();
        this.ui.setGlazeStatus("Nothing heard. Try again, or use the typed field.");
        return;
      }
      print("[Glaze] transcript: \"" + text + "\"");
      this.requestGlaze(text);
    });
  }

  // ── Gemini ────────────────────────────────────────────────────────────────

  private requestGlaze(transcript: string): void {
    if (this.isThinking) return;

    const cached = this.cache.get(transcript);
    if (cached !== null) {
      print("[Glaze] cache hit for \"" + transcript + "\"");
      this.applyResult(cached, true);
      return;
    }

    this.isThinking = true;
    this.timedOut = false;
    this.ui.setGlazeStatus("Thinking…");

    // The gateway call has no timeout of its own, so arm one here. Whichever
    // fires first wins; the loser is ignored via the timedOut / isThinking flags.
    const timer = this.createEvent("DelayedCallbackEvent");
    timer.bind(() => {
      if (!this.isThinking) return;
      this.timedOut = true;
      print("[Glaze] TIMEOUT after " + this.timeoutSeconds + "s");
      this.fallback(transcript, "Timed out after " + this.timeoutSeconds + "s");
    });
    timer.reset(this.timeoutSeconds);

    Gemini.models({
      model: this.geminiModel,
      type: "generateContent",
      body: {
        contents: [{parts: [{text: transcript}], role: "user"}],
        systemInstruction: {parts: [{text: GLAZE_SYSTEM_INSTRUCTION}]},
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.6
        }
      }
    })
      .then((response) => {
        if (this.timedOut) return;
        const raw = this.extractText(response);
        // Raw reply to the Logger verbatim - the only way to debug a model
        // that has decided to answer in prose today.
        print("[Glaze] RAW RESPONSE: " + raw);

        const parsed = parseGlazeReply(raw);
        if (parsed === null) {
          this.fallback(transcript, "Reply was not valid JSON");
          return;
        }
        const result: GlazeResult = {
          name: parsed.name,
          params: parsed.params,
          offline: false,
          reason: ""
        };
        this.cache.set(transcript, result);
        this.applyResult(result, false);
      })
      .catch((err) => {
        if (this.timedOut) return;
        print("[Glaze] REQUEST FAILED: " + err);
        this.fallback(transcript, "Network error");
      });
  }

  /** candidates[0].content.parts[*].text, defensively. */
  private extractText(response: any): string {
    try {
      const parts = response.candidates[0].content.parts;
      let out = "";
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] && typeof parts[i].text === "string") out += parts[i].text;
      }
      return out;
    } catch (e) {
      return "";
    }
  }

  private fallback(transcript: string, reason: string): void {
    const result = offlineGlaze(transcript, reason);
    print("[Glaze] offline fallback -> " + result.name + " (" + reason + ")");
    this.applyResult(result, false);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  private applyResult(result: GlazeResult, fromCache: boolean): void {
    this.isThinking = false;
    // Every outcome lands here - model reply, cache hit, timeout, network
    // failure - so the bloom is the single honest end to the gesture and the
    // working beat has no path that leaves it spinning.
    this.enterResolve();
    const from = this.current !== null ? this.current : this.readMaterial();
    const to = result.params;

    animate({
      duration: this.transitionSeconds,
      easing: "ease-out-quad",
      update: (t: number) => this.writeMaterial(from, to, t),
      ended: () => {
        this.writeMaterial(from, to, 1);
        this.current = to;
      }
    });

    this.ui.setGlazeState("GLAZED");
    if (result.offline) {
      this.ui.setGlazeStatus(result.reason + " — used offline glaze: " + result.name);
    } else {
      this.ui.setGlazeStatus((fromCache ? "Cached: " : "Applied: ") + result.name);
    }
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private lerpColor(a: number[], b: number[], t: number): vec4 {
    return new vec4(
      this.lerp(a[0], b[0], t), this.lerp(a[1], b[1], t),
      this.lerp(a[2], b[2], t), this.lerp(a[3], b[3], t)
    );
  }

  /** Runtime material writes go through mainPass, never passInfos. */
  private writeMaterial(from: GlazeParams, to: GlazeParams, t: number): void {
    const p = this.glazeMaterial.mainPass as any;
    p.baseColorBottom = this.lerpColor(from.baseColorBottom, to.baseColorBottom, t);
    p.baseColorTop = this.lerpColor(from.baseColorTop, to.baseColorTop, t);
    p.rimTint = this.lerpColor(from.rimTint, to.rimTint, t);
    p.roughness = this.lerp(from.roughness, to.roughness, t);
    p.metallic = this.lerp(from.metallic, to.metallic, t);
    p.crackleScale = this.lerp(from.crackleScale, to.crackleScale, t);
    p.crackleIntensity = this.lerp(from.crackleIntensity, to.crackleIntensity, t);
    p.dripAmount = this.lerp(from.dripAmount, to.dripAmount, t);
    p.glossBands = this.lerp(from.glossBands, to.glossBands, t);
    p.firedGlow = this.lerp(from.firedGlow, to.firedGlow, t);
  }

  private c4(v: any, fallback: number[]): [number, number, number, number] {
    if (!v) return [fallback[0], fallback[1], fallback[2], fallback[3]];
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
      firedGlow: p.firedGlow !== undefined ? p.firedGlow : 0
    };
  }
}
