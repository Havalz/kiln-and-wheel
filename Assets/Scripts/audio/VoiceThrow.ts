/**
 * WHEEL - VoiceThrow
 *
 * VOICE-THROWN: hold the button, hum, and the pot grows out of the shape of
 * your voice. Loudness over time becomes radius over height - a swell in the
 * middle of the hum becomes a belly, a thin tail becomes a narrow neck.
 *
 * THE RESULT IS A SEED, NOT A RESULT. The eight control points are written as a
 * new starting silhouette and every handle stays fully editable afterwards.
 * The voice gets you to an interesting shape in four seconds; the hands finish
 * it. Nothing here locks anything.
 *
 * The maths lives in core/VoiceEnvelope.ts, free of Lens API types so the whole
 * normalise -> smooth -> resample -> map pipeline runs under plain Node (35
 * assertions). This file is only microphone plumbing, the growth animation, and
 * the level bar.
 */

import {LatheMesher} from "../core/LatheMesher";
import {WheelStudioUI} from "../WheelStudioUI";
import {
  MIN_RADIUS,
  VOICE_POINTS,
  frameRms,
  voiceHeights,
  voiceToRadii
} from "../core/VoiceEnvelope";

/** Hard ceiling on a take. */
const MAX_RECORD_S = 4.0;
/** Growth animation length. */
const GROW_S = 0.8;
/**
 * If not one audio frame has arrived in this long, there is no microphone.
 * Lens Studio Preview is the usual reason.
 */
const MIC_TIMEOUT_S = 1.0;
/** Microphone frame scratch. Allocated once; getAudioFrame fills it in place. */
const FRAME_CAPACITY = 2048;
/** Safety cap on the per-update drain loop. */
const MAX_FRAMES_PER_UPDATE = 64;

@component
export class VoiceThrow extends BaseScriptComponent {
  @ui.label("Voice-thrown silhouette — hum a pot into being")
  @ui.separator

  @input @hint("Owns the ProfileModel the voice writes into.") mesher: LatheMesher;
  @input @allowUndefined @hint("Supplies the THROW WITH VOICE button and status line.") ui: WheelStudioUI;

  @input
  @allowUndefined
  @hint("Audio Track asset backed by a Microphone provider. Without it the editor path still works.")
  microphone: AudioTrackAsset;

  @ui.group_start("Level bar")
  @input @hint("Bright bar shown beside the wheel while recording.")
  @widget(new ColorWidget())
  barColor: vec4 = new vec4(0.30, 1.0, 0.72, 1.0);

  @input @hint("Where the bar sits relative to the wheel, in cm.")
  barOffset: vec3 = new vec3(14, 0, 0);

  @input @hint("Bar size in cm: x is width, y is full-scale height.")
  barSize: vec2 = new vec2(1.4, 24);

  @input
  @allowUndefined
  @hint("Unlit material for the bar. Without one the bar is skipped rather than drawn untextured.")
  barMaterial: Material;
  @ui.group_end

  @ui.group_start("Editor trigger (no microphone in Preview)")
  @input
  @hint("Eight raw loudness values. Fed through the IDENTICAL pipeline the microphone uses.")
  editorEnvelope: number[] = [0.15, 0.45, 0.9, 0.75, 0.4, 0.55, 0.85, 0.25];

  @input
  @hint("Tick to throw a pot from editorEnvelope. Auto-clears.")
  runVoiceThrowNow: boolean = false;

  @input
  @hint("Tick to start a real recording without the button — the way to exercise the microphone and the no-mic abort in the simulator. Auto-clears.")
  runVoiceRecordNow: boolean = false;
  @ui.group_end

  private provider: any = null;
  private frame = new Float32Array(FRAME_CAPACITY);
  private envelope: number[] = [];

  private recording = false;
  private recordElapsed = 0;
  private sawAudio = false;

  private growing = false;
  private growElapsed = 0;
  private fromRadii: number[] = [];
  private toRadii: number[] = [];

  private barRoot: SceneObject = null;
  private barTransform: Transform = null;
  private level = 0;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.mesher) {
      print("[Voice] no mesher assigned - voice throwing is inert.");
      return;
    }
    this.buildBar();

    if (this.microphone) {
      // The provider is the microphone; the asset is just its container.
      this.provider = this.microphone.control as any;
    } else {
      print("[Voice] no microphone asset assigned - editor path only.");
    }

    if (this.ui) {
      this.ui.onVoiceThrowDown.add(() => this.beginRecording());
      this.ui.onVoiceThrowUp.add(() => this.finishRecording("released"));
    }
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  private beginRecording(): void {
    if (this.recording || this.growing) return;
    this.envelope = [];
    this.recordElapsed = 0;
    this.sawAudio = false;
    this.level = 0;
    this.recording = true;

    if (this.provider && this.provider.start) {
      try {
        this.provider.start();
      } catch (e) {
        print("[Voice] microphone start failed: " + e);
      }
    }
    this.setBarVisible(true);
    this.status("Listening…");
    print("[Voice] recording started");
  }

  /**
   * Stop and shape. Called on release and on the 4s ceiling, so it must be safe
   * to call twice - the second call finds recording already false and returns.
   */
  private finishRecording(reason: string): void {
    if (!this.recording) return;
    this.recording = false;
    this.setBarVisible(false);
    this.stopProvider();

    if (!this.sawAudio) {
      // Abort cleanly: no shape change, no half-applied profile.
      this.status("No microphone");
      print("[Voice] ABORTED - no audio frames within " + MIC_TIMEOUT_S +
            "s. Expected in Lens Studio Preview. Use editorEnvelope + " +
            "runVoiceThrowNow to exercise the same path.");
      return;
    }

    print("[Voice] recording ended (" + reason + ") after " +
          this.recordElapsed.toFixed(2) + "s, " + this.envelope.length + " frames");
    this.throwFrom(this.envelope, "voice");
  }

  private stopProvider(): void {
    if (this.provider && this.provider.stop) {
      try {
        this.provider.stop();
      } catch (e) {
        print("[Voice] microphone stop failed: " + e);
      }
    }
  }

  // ── Shaping ───────────────────────────────────────────────────────────────

  /** Raw loudness values in, growth animation out. Shared by both paths. */
  private throwFrom(raw: number[], source: string): void {
    const radii = voiceToRadii(raw);
    const model = this.mesher.getModel();
    const pts = model.getPoints();

    this.fromRadii = [];
    for (let i = 0; i < VOICE_POINTS; i++) {
      this.fromRadii.push(i < pts.length ? pts[i].r : MIN_RADIUS);
    }
    this.toRadii = radii;
    this.growElapsed = 0;
    this.growing = true;

    this.status("Thrown by voice — the handles are yours");
    print("[Voice] " + source + " -> radii [" +
          radii.map((r) => r.toFixed(2)).join(", ") + "]");
  }

  /**
   * Write the interpolated silhouette. Heights are rewritten every frame too,
   * because ProfileModel re-sorts by y on every setPoint and a point that
   * crossed a neighbour mid-animation would otherwise shuffle the indices the
   * interpolation is addressing.
   */
  private applyGrowth(t: number): void {
    const model = this.mesher.getModel();
    const heights = voiceHeights();
    // Smoothstep: the pot eases out of the old shape and settles into the new
    // one rather than snapping at both ends.
    const e = t * t * (3 - 2 * t);
    for (let i = 0; i < VOICE_POINTS; i++) {
      const r = this.fromRadii[i] + (this.toRadii[i] - this.fromRadii[i]) * e;
      model.setPoint(i, heights[i], r);
    }
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  private onUpdate(): void {
    if (this.runVoiceThrowNow) {
      // Auto-clear FIRST: a trigger left set re-fires on every preview reload.
      this.runVoiceThrowNow = false;
      this.runEditorThrow();
    }

    if (this.runVoiceRecordNow) {
      this.runVoiceRecordNow = false;
      this.beginRecording();
    }

    if (this.recording) {
      this.recordElapsed += getDeltaTime();
      this.pumpMicrophone();
      this.updateBar();
      if (!this.sawAudio && this.recordElapsed >= MIC_TIMEOUT_S) {
        this.finishRecording("no microphone");
      } else if (this.recordElapsed >= MAX_RECORD_S) {
        this.finishRecording("4s ceiling");
      }
    }

    if (this.growing) {
      this.growElapsed += getDeltaTime();
      const t = Math.min(1, this.growElapsed / GROW_S);
      this.applyGrowth(t);
      if (t >= 1) {
        this.growing = false;
        print("[Voice] growth complete - all 8 handles remain editable.");
      }
    }
  }

  /**
   * DRAIN the microphone, do not sip from it. The provider buffers audio at its
   * own cadence, which is not the render cadence; reading a single frame per
   * update leaves the rest queued and starves the envelope. Measured in Preview,
   * one-read-per-update gave 3 frames across a 4 second take - a pot with three
   * steps in it rather than a curve. Looping until the provider reports nothing
   * takes everything it has each frame.
   */
  private pumpMicrophone(): void {
    if (!this.provider || !this.provider.getAudioFrame) return;
    // Bounded so a provider that always reports data cannot wedge the frame.
    for (let guard = 0; guard < MAX_FRAMES_PER_UPDATE; guard++) {
      let shape: any = null;
      try {
        shape = this.provider.getAudioFrame(this.frame);
      } catch (e) {
        return;
      }
      // The provider reports how many samples it actually wrote; the buffer
      // keeps stale samples past that point, so reading the whole array would
      // fold the previous frame's audio into this one's level.
      const count = shape && isFinite(shape.x) ? Math.floor(shape.x) : 0;
      if (count <= 0) return;
      this.sawAudio = true;
      const rms = frameRms(this.frame, count);
      this.envelope.push(rms);
      // Bar level tracks a decaying peak so the display is stable rather than
      // flickering with every glottal pulse.
      this.level = Math.max(rms, this.level * 0.92);
    }
  }

  private runEditorThrow(): void {
    if (!this.mesher) return;
    const raw: number[] = [];
    for (let i = 0; i < this.editorEnvelope.length; i++) {
      raw.push(this.editorEnvelope[i]);
    }
    if (raw.length === 0) {
      print("[Voice] editorEnvelope is empty - nothing to throw.");
      return;
    }
    print("[Voice] EDITOR path: " + raw.length + " values through the same pipeline");
    this.throwFrom(raw, "editor");
  }

  // ── Level bar ─────────────────────────────────────────────────────────────

  /**
   * A single bright quad beside the wheel, built here rather than taken as an
   * asset input so voice throwing needs no new art. Its vertices run y 0..1 so
   * scaling Y grows it upward from its base instead of from its middle.
   */
  private buildBar(): void {
    const builder = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    builder.topology = MeshTopology.Triangles;
    builder.indexType = MeshIndexType.UInt16;
    builder.appendVerticesInterleaved([
      -0.5, 0, 0,  0, 0, 1,  0, 0,
       0.5, 0, 0,  0, 0, 1,  1, 0,
       0.5, 1, 0,  0, 0, 1,  1, 1,
      -0.5, 1, 0,  0, 0, 1,  0, 1
    ]);
    builder.appendIndices([0, 1, 2, 0, 2, 3]);

    this.barRoot = global.scene.createSceneObject("VoiceLevelBar");
    this.barRoot.setParent(this.mesher.sceneObject);
    this.barTransform = this.barRoot.getTransform();
    this.barTransform.setLocalPosition(this.barOffset);

    const visual = this.barRoot.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    visual.mesh = builder.getMesh();

    // Cloned and tinted: on the waveguide the bar has to ADD light to read, so
    // it carries its own bright colour rather than borrowing the pot's glaze.
    if (this.barMaterial) {
      const mat = this.barMaterial.clone();
      const pass = mat.mainPass as any;
      pass.baseColor = this.barColor;
      visual.clearMaterials();
      visual.addMaterial(mat);
    }
    this.setBarVisible(false);
  }

  private updateBar(): void {
    if (!this.barTransform) return;
    const h = Math.max(0.02, Math.min(1, this.level)) * this.barSize.y;
    this.barTransform.setLocalScale(new vec3(this.barSize.x, h, 1));
  }

  private setBarVisible(on: boolean): void {
    if (this.barRoot) this.barRoot.enabled = on;
  }

  private status(msg: string): void {
    if (this.ui) this.ui.setVoiceStatus(msg);
  }
}
