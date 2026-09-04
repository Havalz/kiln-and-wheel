/**
 * WHEEL - WheelAudio
 *
 * Two sounds that make the wheel feel like a tool rather than a viewer.
 *
 *   THE WHEEL SINGS - a hum that follows your hands. While a handle is held the
 *   wheel sings the radius of the profile at that point: wide is low and full,
 *   narrow is high and thin. Silent the moment you let go.
 *
 *   THE PING TEST - tap a pot and listen. A fired piece rings, and the smaller
 *   it is the higher it rings. Unfired clay thuds. Potters really do this to
 *   find cracks, and the absence of a ring is the whole signal.
 *
 * PITCH ON SPECS
 * --------------
 * AudioComponent exposes volume but NO pitch or playback-rate control, so
 * neither "pitch" here is a pitch shift:
 *   - the hum crossfades two loops rendered at different fundamentals, which
 *     changes timbre continuously with no clip restarts;
 *   - the ping picks the nearest of three pre-rendered bells.
 *
 * SOURCE BUDGET
 * -------------
 * 3 components live here (2 hum + 1 ping, whose track is swapped between four
 * clips). Worst case concurrent playback is 3 - both hums plus a ping - and the
 * kiln's own sounds cannot overlap a drag, because a fired piece is locked.
 */

import {Interactable as SIKInteractable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";

import {ProfileHandles} from "./core/ProfileHandles";
import {LatheMesher} from "./core/LatheMesher";
import {KilnStation} from "./KilnStation";
import {
  crossfadeGains,
  pitchToBell,
  potVolume,
  radiusAt,
  radiusToHumBlend,
  radiusToHumGain,
  volumeToPitch01
} from "./core/PotAcoustics";
import type {BellPitch} from "./core/PotAcoustics";

@component
export class WheelAudio extends BaseScriptComponent {
  @ui.label("Wheel audio — hum + ping test")
  @ui.separator
  @input handles: ProfileHandles;
  @input mesher: LatheMesher;
  @input @allowUndefined @hint("Used only to ask whether the piece is fired.") kiln: KilnStation;

  @ui.group_start("Hum loops")
  @input @allowUndefined @hint("Low fundamental. Dominates when the profile is wide.") humLowTrack: AudioTrackAsset;
  @input @allowUndefined @hint("High fundamental. Dominates when the profile is narrow.") humHighTrack: AudioTrackAsset;
  @input
  @hint("Master level for the wheel hum.")
  @widget(new SliderWidget(0, 1, 0.05))
  humVolume: number = 0.55;
  @ui.group_end

  @ui.group_start("Ping test")
  @input @allowUndefined @hint("Fired, large pot.") bellLowTrack: AudioTrackAsset;
  @input @allowUndefined @hint("Fired, medium pot.") bellMidTrack: AudioTrackAsset;
  @input @allowUndefined @hint("Fired, small pot — the highest note.") bellHighTrack: AudioTrackAsset;
  @input @allowUndefined @hint("Unfired clay. Damped, almost no tail.") thudTrack: AudioTrackAsset;
  @ui.group_end

  private humLow: AudioComponent = null;
  private humHigh: AudioComponent = null;
  private ping: AudioComponent = null;

  /** Smoothed so the hum glides rather than stepping per frame. */
  private blend = 0;
  private gain = 0;
  private humming = false;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.handles || !this.mesher) {
      print("[WheelAudio] handles or mesher not assigned - audio inert.");
      return;
    }

    this.humLow = this.makeAudio(this.humLowTrack, Audio.PlaybackMode.LowPower);
    this.humHigh = this.makeAudio(this.humHighTrack, Audio.PlaybackMode.LowPower);
    // The ping answers a tap, so it needs the low-latency path; a LowPower
    // delay of tens of ms would break the tap-and-listen feel entirely.
    this.ping = this.makeAudio(this.thudTrack, Audio.PlaybackMode.LowLatency);

    // Both loops run continuously at zero volume and are mixed by gain alone.
    // Starting and stopping them per drag would click and re-trigger attacks.
    this.startLoop(this.humLow);
    this.startLoop(this.humHigh);

    this.setupPingTarget();
  }

  private makeAudio(track: AudioTrackAsset, mode: any): AudioComponent {
    if (!track) return null;
    const a = this.sceneObject.createComponent("Component.AudioComponent") as AudioComponent;
    a.audioTrack = track;
    a.volume = 0;
    a.playbackMode = mode;
    return a;
  }

  private startLoop(a: AudioComponent): void {
    if (!a) return;
    a.volume = 0;
    a.play(-1);   // -1 loops forever
  }

  // ── The wheel sings ───────────────────────────────────────────────────────

  private onUpdate(): void {
    if (this.humLow === null && this.humHigh === null) return;

    const held = this.handles.getHeldIndex();
    let targetBlend = this.blend;
    let targetGain = 0;

    if (held >= 0) {
      const r = radiusAt(this.mesher.getModel().getPoints(), held);
      targetBlend = radiusToHumBlend(r);
      targetGain = radiusToHumGain(r) * this.humVolume;
      this.humming = true;
    } else if (this.humming) {
      // Idle: fade to silence rather than cutting, so releasing a handle does
      // not end the note with a click.
      this.humming = targetGain > 0.001;
    }

    // Frame-rate independent glide toward the target.
    const k = Math.min(1, getDeltaTime() * 9);
    this.blend += (targetBlend - this.blend) * k;
    this.gain += (targetGain - this.gain) * k;

    const g = crossfadeGains(this.blend);
    if (this.humLow) this.humLow.volume = g.low * this.gain;
    if (this.humHigh) this.humHigh.volume = g.high * this.gain;
  }

  // ── The ping test ─────────────────────────────────────────────────────────

  /** Make the pot itself tappable. Not a UI button - this is the object. */
  private setupPingTarget(): void {
    const pot = this.mesher.sceneObject;

    let collider = pot.getComponent("Physics.ColliderComponent") as any;
    if (!collider) {
      collider = pot.createComponent("Physics.ColliderComponent");
      const shape = Shape.createBoxShape();
      // Roughly the vessel's bounds; a capsule would hug the silhouette better
      // but a box is enough to catch a deliberate tap.
      shape.size = new vec3(18, 24, 18);
      collider.shape = shape;
      collider.debugDrawEnabled = false;
    }

    // Created unconditionally: the vessel is a mesh with no interaction of its
    // own, and getComponent() here resolves to the engine's Interactable rather
    // than SIK's, which has no onTriggerUp.
    const interactable: SIKInteractable =
      pot.createComponent(SIKInteractable.getTypeName()) as unknown as SIKInteractable;
    interactable.targetingMode = 3;
    // Interactable exposes onTriggerStart/onTriggerEnd; onTriggerUp belongs to
    // Element/Button. Firing on END makes it a tap-and-release, which is what
    // a potter's ping actually is.
    interactable.onTriggerEnd.add(() => this.pingTest());
  }

  /**
   * Tap the pot. Fired clay rings at a pitch set by how much of it there is;
   * anything softer thuds.
   */
  pingTest(): void {
    if (!this.ping) return;

    const fired = this.kiln ? this.kiln.isFired() : false;
    if (!fired) {
      this.ping.audioTrack = this.thudTrack;
      this.ping.volume = 0.85;
      this.ping.play(1);
      print("[WheelAudio] ping: unfired — thud");
      return;
    }

    const vol = potVolume(
      this.mesher.getModel().getSamples(),
      this.mesher.height,
      this.mesher.radiusScale
    );
    const pitch = volumeToPitch01(vol);
    const bell: BellPitch = pitchToBell(pitch);
    const track =
      bell === "high" ? this.bellHighTrack :
      bell === "mid" ? this.bellMidTrack : this.bellLowTrack;

    if (!track) return;
    this.ping.audioTrack = track;
    this.ping.volume = 0.9;
    this.ping.play(1);
    print("[WheelAudio] ping: fired, volume=" + vol.toFixed(0) +
          "cm3 pitch=" + pitch.toFixed(2) + " bell=" + bell);
  }
}
