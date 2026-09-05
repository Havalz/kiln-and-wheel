/**
 * WHEEL - FirstRunHints
 *
 * One bright line above the wheel that walks a first-time user through the
 * loop: Shape it -> Glaze it -> Fire it -> Take it home. Each step clears when
 * the user actually does the thing, and the whole hint retires for good once
 * they finish a full cycle.
 *
 * IT WATCHES STATE, IT DOES NOT SUBSCRIBE. Every step is detected by comparing
 * observable state against what it was at startup - the serialized profile, the
 * glaze colour on the material, kiln.isFired(), placement.hasPlaced(). That
 * keeps the hint completely decoupled: no other component has to know it
 * exists, and adding or removing it can never change how the studio behaves.
 * The cost is one cheap poll per second, not per frame.
 */

import {KilnStation} from "./KilnStation";
import {PotPlacement} from "./PotPlacement";
import {LatheMesher} from "./core/LatheMesher";

/** Survives restarts, so the hint is genuinely first-RUN and not first-launch. */
const SEEN_KEY = "wheel.hints.v1";
/** Cheap enough to poll; slow enough to cost nothing. */
const POLL_S = 0.5;
/** Beat between finishing the loop and the hint retiring, so the last line is read. */
const FAREWELL_S = 3.0;

const STEPS = [
  "Shape it — pinch a handle and pull",
  "Glaze it — hold the mic and describe one",
  "Fire it — press FIRE at the kiln",
  "Take it home — pinch the pot and let go"
];

@component
export class FirstRunHints extends BaseScriptComponent {
  @ui.label("First-run guidance — retires after one full cycle")
  @ui.separator

  @input @hint("Supplies the profile the shaping step watches.") mesher: LatheMesher;
  @input @allowUndefined @hint("Supplies isFired() for the firing step.") kiln: KilnStation;
  @input @allowUndefined @hint("Supplies hasPlaced() for the final step.") placement: PotPlacement;
  @input @allowUndefined @hint("GlazeMat, watched for the glaze step.") glazeMaterial: Material;

  @input
  @hint("Where the line sits relative to the wheel, in cm.")
  offset: vec3 = new vec3(0, 30, 0);

  @input
  @hint("Near-white. On the waveguide the hint must ADD light to be read.")
  @widget(new ColorWidget())
  hintColor: vec4 = new vec4(1, 0.98, 0.92, 1);

  @input
  @hint("Tick to show the hints again, as if this were a first run. Auto-clears.")
  replayHintsNow: boolean = false;

  private text: Text = null;
  private step = 0;
  private done = false;
  private elapsed = 0;
  private farewell = -1;

  private baseProfile = "";
  private baseGlaze: vec4 = null;

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.mesher) {
      print("[Hints] no mesher assigned - guidance is inert.");
      return;
    }
    this.baseProfile = this.mesher.getModel().serialize();
    this.baseGlaze = this.readGlaze();

    if (this.hasSeen()) {
      // Already completed a cycle on this device; never show it again.
      this.done = true;
      return;
    }
    this.build();
    this.show(STEPS[0]);
  }

  private build(): void {
    const host = global.scene.createSceneObject("FirstRunHint");
    host.setParent(this.mesher.sceneObject);
    host.getTransform().setLocalPosition(this.offset);

    const t = host.createComponent("Component.Text") as Text;
    t.text = "";
    t.size = 46;
    t.depthTest = true;
    t.textFill.color = this.hintColor;
    t.horizontalAlignment = HorizontalAlignment.Center;
    t.verticalAlignment = VerticalAlignment.Center;
    t.horizontalOverflow = HorizontalOverflow.Wrap;
    t.verticalOverflow = VerticalOverflow.Overflow;
    t.layoutRect = Rect.create(-14, 14, -3, 3);
    this.text = t;
  }

  // ── Step detection ────────────────────────────────────────────────────────

  private readGlaze(): vec4 {
    if (!this.glazeMaterial) return null;
    try {
      return (this.glazeMaterial.mainPass as any).baseColorTop as vec4;
    } catch (e) {
      return null;
    }
  }

  private shaped(): boolean {
    return this.mesher.getModel().serialize() !== this.baseProfile;
  }

  private glazed(): boolean {
    const now = this.readGlaze();
    if (now === null || this.baseGlaze === null) return false;
    // Any channel moving means a glaze was applied - by voice, by fallback, or
    // by reloading a piece from the shelf. All three count as "glazed it".
    return Math.abs(now.x - this.baseGlaze.x) > 0.01 ||
           Math.abs(now.y - this.baseGlaze.y) > 0.01 ||
           Math.abs(now.z - this.baseGlaze.z) > 0.01;
  }

  private fired(): boolean {
    return this.kiln ? this.kiln.isFired() : false;
  }

  private placed(): boolean {
    return this.placement ? this.placement.hasPlaced() : false;
  }

  /**
   * How far through the loop the user actually is.
   *
   * LATER STAGES IMPLY EARLIER ONES, which is not a shortcut but a correctness
   * fix: glazing is optional - a pot fires perfectly well with its default
   * glaze - so checking `glazed()` on its own left the hint stuck on "Glaze it"
   * forever for anyone who skipped the bench, and the guidance could then never
   * retire. Firing means they got past glazing whether or not they used it.
   */
  private stage(): number {
    if (this.placed()) return 4;
    if (this.fired()) return 3;
    if (this.glazed()) return 2;
    if (this.shaped()) return 1;
    return 0;
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  private onUpdate(): void {
    if (this.replayHintsNow) {
      this.replayHintsNow = false;
      this.replay();
    }
    if (this.done || !this.mesher) return;

    // Retiring: hold the last line briefly so it is read, then go.
    if (this.farewell >= 0) {
      this.farewell += getDeltaTime();
      if (this.farewell >= FAREWELL_S) {
        this.show("");
        this.done = true;
        this.markSeen();
        print("[Hints] full cycle complete - guidance retired.");
      }
      return;
    }

    this.elapsed += getDeltaTime();
    if (this.elapsed < POLL_S) return;
    this.elapsed = 0;

    // Never walk backwards: a placed pot that is later reshaped should not send
    // a first-timer back to step one.
    const reached = this.stage();
    if (reached > this.step) this.step = reached;
    if (this.step >= STEPS.length) {
      this.show("That's the loop — well thrown.");
      this.farewell = 0;
      return;
    }
    this.show(STEPS[this.step]);
  }

  private show(msg: string): void {
    if (this.text) this.text.text = msg;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private hasSeen(): boolean {
    try {
      const store = global.persistentStorageSystem.store;
      return store.has(SEEN_KEY) && store.getString(SEEN_KEY) === "1";
    } catch (e) {
      return false;   // storage trouble must not cost a first-timer the guidance
    }
  }

  private markSeen(): void {
    try {
      // putString, not putBool: the shelf has round-tripped strings reliably all
      // through this project, and a bool written here did not survive a reload.
      global.persistentStorageSystem.store.putString(SEEN_KEY, "1");
    } catch (e) {
      print("[Hints] could not record completion: " + e);
    }
  }

  /** Editor affordance: show the guidance again without clearing storage by hand. */
  private replay(): void {
    try {
      global.persistentStorageSystem.store.remove(SEEN_KEY);
    } catch (e) {}
    this.step = 0;
    this.farewell = -1;
    this.done = false;
    this.baseProfile = this.mesher ? this.mesher.getModel().serialize() : "";
    this.baseGlaze = this.readGlaze();
    if (!this.text) this.build();
    this.show(STEPS[0]);
    print("[Hints] replaying first-run guidance.");
  }
}
