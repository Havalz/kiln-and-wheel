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

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.pollTypedTrigger());
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

  private startListening(): void {
    if (this.isListening || this.isThinking) return;
    this.isListening = true;
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
      this.ui.setGlazeStatus("Mic unavailable (" + code + "). Use the typed field.");
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
    print("[Glaze] mic up");
    this.asrModule.stopTranscribing().then(() => {
      const text = this.latestTranscript.trim();
      if (text.length === 0) {
        this.ui.setGlazeStatus("Nothing heard. Try again, or use the typed field.");
        return;
      }
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
