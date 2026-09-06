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
  VOICE_POINTS, MIN_RADIUS, MAX_RADIUS, frameRms, voiceToRadii, voiceHeights,
  normalizeEnvelope, smoothEnvelope, resampleEnvelope, envelopeToRadii,
  smoothWindowFor, clamp
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

/**
 * Rows in the live silhouette ribbon. Enough that the curve reads as a curve
 * rather than a staircase, cheap enough to rewrite every frame.
 */
const SIL_ROWS = 48;
/** Slim progress track beside the silhouette, in cm. */
const PROGRESS_W_CM = 0.9;

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
  @input
  @hint("Fill colour of the 4-second progress track. Bright: it has to add light on the waveguide.")
  @widget(new ColorWidget())
  progressColor: vec4 = new vec4(1.0, 0.78, 0.22, 1.0);
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
  @input
  @hint("Hold the live silhouette on screen, drawn from editorEnvelope, so it can be inspected or captured without racing the 4s take. Recording clears it.")
  holdPreviewNow: boolean = false;
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

  private previewRoot: SceneObject = null;
  private silRoot: SceneObject = null;
  private silBuilder: MeshBuilder = null;
  private silMat: Material = null;
  private silTransform: Transform = null;
  private progRoot: SceneObject = null;
  private progTransform: Transform = null;
  private progMat: Material = null;
  private level = 0;
  private holding = false;
  private readonly silVtx: number[] = [0, 0, 0, 0, 0, 1, 0, 0];

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.mesher) {
      print("[Voice] no mesher assigned - voice throwing is inert.");
      return;
    }
    this.buildSilhouette();

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
    this.setPreviewVisible(true);
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
    this.stopProvider();

    if (!this.sawAudio) {
      this.setPreviewVisible(false);
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
      this.updatePreview();
      if (!this.sawAudio && this.recordElapsed >= MIC_TIMEOUT_S) {
        this.finishRecording("no microphone");
      } else if (this.recordElapsed >= MAX_RECORD_S) {
        this.finishRecording("4s ceiling");
      }
    }

    if (this.holdPreviewNow && !this.recording && !this.growing) {
      if (!this.holding) {
        this.holding = true;
        this.setPreviewVisible(true);
        print("[Voice] preview HELD from editorEnvelope - clear holdPreviewNow to release.");
      }
      const raw: number[] = [];
      for (let i = 0; i < this.editorEnvelope.length; i++) raw.push(this.editorEnvelope[i]);
      this.writeSilhouette(raw, 0.6, 1, 1);
    } else if (this.holding) {
      this.holding = false;
      this.setPreviewVisible(false);
    }

    if (this.growing) {
      this.growElapsed += getDeltaTime();
      const t = Math.min(1, this.growElapsed / GROW_S);
      this.applyGrowth(t);
      this.updateHandoff(t);
      if (t >= 1) {
        this.growing = false;
        this.setPreviewVisible(false);
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

  // ── Live silhouette ───────────────────────────────────────────────────────

  /**
   * THE FEEDBACK IS THE TOOL. Loudness here is not a level to be metered - it
   * IS the pot's profile, so the preview draws the silhouette itself: a ribbon
   * whose half-width at each row is the radius that row of the vessel will
   * have. Humming louder pushes the curve wide, going quiet pinches it in, and
   * the whole thing grows upward as the four seconds run out. A generic meter
   * would have shown that the microphone works; this shows what you are making.
   *
   * It is computed with the SAME pipeline that shapes the final pot -
   * normalize, smooth, resample, envelopeToRadii - so the preview cannot drift
   * from the result. What you watch being drawn is what you get.
   */
  private buildSilhouette(): void {
    this.silBuilder = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    this.silBuilder.topology = MeshTopology.Triangles;
    this.silBuilder.indexType = MeshIndexType.UInt16;

    const zeros: number[] = new Array(SIL_ROWS * 2 * 8);
    for (let i = 0; i < zeros.length; i++) zeros[i] = 0;
    this.silBuilder.appendVerticesInterleaved(zeros);

    const idx: number[] = [];
    for (let r = 0; r < SIL_ROWS - 1; r++) {
      const a = r * 2;
      idx.push(a, a + 1, a + 2);
      idx.push(a + 2, a + 1, a + 3);
    }
    this.silBuilder.appendIndices(idx);

    // NOT parented to the lathe. The wheel spins, and a preview that rotates
    // away from the viewer mid-take is worse than none - the first build put it
    // at local +14cm and the spin had carried it to world -14cm by the time it
    // was looked at. Its own root at the wheel's position, identity rotation.
    this.previewRoot = global.scene.createSceneObject("VoicePreview");
    this.previewRoot.getTransform().setWorldPosition(
      this.mesher.sceneObject.getTransform().getWorldPosition());

    this.silRoot = global.scene.createSceneObject("VoiceSilhouette");
    this.silRoot.setParent(this.previewRoot);
    this.silRoot.layer = this.mesher.sceneObject.layer;
    this.silTransform = this.silRoot.getTransform();
    this.silTransform.setLocalPosition(this.barOffset);

    const visual = this.silRoot.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    visual.mesh = this.silBuilder.getMesh();
    if (this.barMaterial) {
      this.silMat = this.barMaterial.clone();
      (this.silMat.mainPass as any).baseColor = this.barColor;
      visual.clearMaterials();
      visual.addMaterial(this.silMat);
    }

    this.progRoot = this.buildQuad("VoiceProgress",
      this.barOffset.add(new vec3(this.barSize.x * 0.5 + 1.6, 0, 0)), this.progressColor);
    this.progTransform = this.progRoot.getTransform();

    this.setPreviewVisible(false);
  }

  /** A unit quad running y 0..1, so scaling Y grows it upward from its base. */
  private buildQuad(name: string, offset: vec3, color: vec4): SceneObject {
    const b = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ]);
    b.topology = MeshTopology.Triangles;
    b.indexType = MeshIndexType.UInt16;
    b.appendVerticesInterleaved([
      -0.5, 0, 0,  0, 0, 1,  0, 0,
       0.5, 0, 0,  0, 0, 1,  1, 0,
       0.5, 1, 0,  0, 0, 1,  1, 1,
      -0.5, 1, 0,  0, 0, 1,  0, 1
    ]);
    b.appendIndices([0, 1, 2, 0, 2, 3]);
    b.updateMesh();   // commit, or the mesh reports empty and draws nothing

    const root = global.scene.createSceneObject(name);
    root.setParent(this.previewRoot);
    root.layer = this.mesher.sceneObject.layer;
    root.getTransform().setLocalPosition(offset);
    const v = root.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    v.mesh = b.getMesh();
    if (this.barMaterial) {
      const m = this.barMaterial.clone();
      (m.mainPass as any).baseColor = color;
      v.clearMaterials();
      v.addMaterial(m);
      if (name === "VoiceProgress") this.progMat = m;
    }
    return root;
  }

  /**
   * Map whatever has been heard so far onto the rows filled so far. `filled`
   * tracks elapsed time, not sample count, so the curve climbs at a steady
   * readable rate instead of lurching when the provider hands over a burst.
   */
  private writeSilhouette(envelope: number[], progress: number, alpha: number,
      widthScale: number): void {
    const filled = Math.max(2, Math.round(clamp(progress, 0, 1) * SIL_ROWS));
    let radii: number[] = [];
    if (envelope.length >= 2) {
      const norm = normalizeEnvelope(envelope);
      const sm = smoothEnvelope(norm, smoothWindowFor(norm.length));
      // resampleEnvelope upsamples by NEAREST NEIGHBOUR on purpose - it must not
      // invent detail for the eight control points that define the real pot.
      // A preview is a different job: the finished vessel is a Catmull-Rom
      // through those points, so drawing a staircase would misrepresent it.
      // Interpolate for display only; the data path is untouched.
      radii = envelopeToRadii(this.lerpResample(sm, filled));
    } else {
      for (let i = 0; i < filled; i++) radii.push(MIN_RADIUS);
    }

    const halfW = this.barSize.x * 0.5 * widthScale;
    const topY = clamp(progress, 0, 1) * this.barSize.y;
    const v = this.silVtx;
    for (let i = 0; i < SIL_ROWS; i++) {
      let y = topY;
      let r = 0;
      if (i < filled) {
        y = (filled > 1 ? i / (filled - 1) : 0) * topY;
        r = (radii[i] / MAX_RADIUS) * halfW;
      }
      v[1] = y; v[2] = 0; v[3] = 0; v[4] = 0; v[5] = 1; v[7] = y / this.barSize.y;
      v[0] = -r; v[6] = 0;
      this.silBuilder.setVertexInterleaved(i * 2, v);
      v[0] = r; v[6] = 1;
      this.silBuilder.setVertexInterleaved(i * 2 + 1, v);
    }
    if (this.silBuilder.isValid()) this.silBuilder.updateMesh();

    if (this.silMat) {
      const c = this.barColor;
      (this.silMat.mainPass as any).baseColor =
        new vec4(c.x * alpha, c.y * alpha, c.z * alpha, c.w * alpha);
    }
    if (this.progTransform) {
      this.progTransform.setLocalScale(
        new vec3(PROGRESS_W_CM, Math.max(0.01, clamp(progress, 0, 1)) * this.barSize.y, 1));
    }
  }

  /** Linear upsample, for the preview curve only. */
  private lerpResample(values: number[], count: number): number[] {
    const n = values.length;
    const out: number[] = [];
    if (n === 0 || count <= 0) return out;
    if (n === 1) {
      for (let i = 0; i < count; i++) out.push(values[0]);
      return out;
    }
    for (let i = 0; i < count; i++) {
      const u = count > 1 ? (i / (count - 1)) * (n - 1) : 0;
      const lo = Math.floor(u);
      const hi = Math.min(n - 1, lo + 1);
      const f = u - lo;
      out.push(values[lo] + (values[hi] - values[lo]) * f);
    }
    return out;
  }

  /**
   * NO FAKE LIFE. Until a frame has actually arrived the curve stays flat at
   * its minimum radius: a dead microphone and a silent one look the same to
   * the code, but neither may look like a working one to the user.
   */
  private updatePreview(): void {
    const progress = clamp(this.recordElapsed / MAX_RECORD_S, 0, 1);
    // The curve appears only once a frame has actually arrived. A dead mic and
    // a silent one are indistinguishable to the code, so until there is real
    // input the only thing moving is the progress track - which is a clock, not
    // a claim about hearing anything.
    if (this.silRoot) this.silRoot.enabled = this.sawAudio;
    if (!this.sawAudio) {
      if (this.progTransform) {
        this.progTransform.setLocalScale(
          new vec3(PROGRESS_W_CM, Math.max(0.01, progress) * this.barSize.y, 1));
      }
      return;
    }
    this.writeSilhouette(this.envelope, progress, 1, 1);
  }

  /**
   * THE HANDOFF. On release the drawn curve does not blink out: over the same
   * 0.8s the clay is growing, the preview slides in toward the wheel, widens to
   * the vessel's own scale and fades to nothing - so the shape you drew is seen
   * becoming the shape on the wheel rather than being replaced by it.
   */
  private updateHandoff(t: number): void {
    if (!this.silTransform) return;
    const e = t * t * (3 - 2 * t);
    const from = this.barOffset;
    this.silTransform.setLocalPosition(
      new vec3(from.x * (1 - e), from.y * (1 - e), from.z * (1 - e)));
    const widthScale = 1 + e * ((this.mesher.radiusScale * 2) / this.barSize.x - 1);
    this.writeSilhouette(this.envelope, 1, 1 - e, widthScale);
    if (this.progRoot) this.progRoot.enabled = false;
  }

  private setPreviewVisible(on: boolean): void {
    if (this.silRoot) this.silRoot.enabled = on;
    if (this.progRoot) this.progRoot.enabled = on;
    if (on && this.silTransform) this.silTransform.setLocalPosition(this.barOffset);
  }

  private status(msg: string): void {
    if (this.ui) this.ui.setVoiceStatus(msg);
  }
}
