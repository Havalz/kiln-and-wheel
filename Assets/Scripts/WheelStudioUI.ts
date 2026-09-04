/**
 * WHEEL - WheelStudioUI
 *
 * Three world-space stations in a shallow arc at arm's reach:
 *   THE WHEEL        0 deg   (control panel under the spinning vessel)
 *   THE GLAZE BENCH +60 deg  (station marker, controls arrive with the glaze pass)
 *   THE KILN        -60 deg  (station marker, controls arrive with the firing pass)
 *
 * WAVEGUIDE PALETTE (hard constraint)
 * -----------------------------------
 * Black renders TRANSPARENT on this display, so the usual dark-panel/light-text
 * convention is inverted here: every surface is a bright, saturated, translucent
 * fill and every glyph is near-white. UIKit's BackPlate ships a near-black
 * default (HSV value 0.09) which would vanish, so each plate is retinted through
 * the RoundedRectangle on its own SceneObject. No dark fills, no black text, no
 * drop shadows anywhere in this file.
 *
 * Contrast note: on an additive display a glyph can only ADD light, never subtract.
 * So legibility comes from the text being brighter and WHITER than the saturated
 * fill behind it -- not from a dark-on-light relationship, which is unrenderable.
 *
 * This module owns no game logic. It emits typed events; WheelStudioWiring
 * subscribes and drives LatheMesher / ProfileHandles.
 */

import {FlexLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout";
import {FlexItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem";
import {
  FlexAlign,
  FlexAlignSelf,
  FlexDirection,
  FlexJustify
} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes";
import {BackPlate} from "SpectaclesUIKit.lspkg/Scripts/BackPlate";
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button";
import {Slider} from "SpectaclesUIKit.lspkg/Scripts/Components/Slider/Slider";
import {GradientParameters, RoundedRectangle} from "SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangle";
import {RoundedRectangleVisual} from "SpectaclesUIKit.lspkg/Scripts/Visuals/RoundedRectangle/RoundedRectangleVisual";
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event";
import {ShelfPot} from "./core/ShelfPot";
import type {ShelfPiece} from "./core/ShelfStore";

// ── Assets ───────────────────────────────────────────────────────────────────
const THEME_FONT = requireAsset("../Fonts/Google Sans Flex.ttf") as Font;
const IMAGE_MAT = requireAsset("../Materials/ImageMaterial.mat") as Material;

const ICON_WHEEL = requireAsset("../Icons/adjust.png") as Texture;
const ICON_GLAZE = requireAsset("../Icons/water_drop.png") as Texture;
const ICON_KILN = requireAsset("../Icons/local_fire_department.png") as Texture;
const ICON_UNDO = requireAsset("../Icons/undo.png") as Texture;
const ICON_RESET = requireAsset("../Icons/refresh.png") as Texture;
const ICON_NEXT = requireAsset("../Icons/arrow_forward.png") as Texture;
const ICON_PLUS = requireAsset("../Icons/add_circle.png") as Texture;
const ICON_MINUS = requireAsset("../Icons/do_not_disturb_on.png") as Texture;

// ── Typography ───────────────────────────────────────────────────────────────
const FONT_SIZE_SCALE = 1.0;

type TextRole =
  | "Title1" | "Title2" | "HeadlineXL" | "Headline1" | "Headline2"
  | "Subheadline" | "Button" | "Callout" | "Body" | "Caption";

const TYPE_SCALE: Record<TextRole, {size: number; weight: number}> = {
  Title1:      {size: 105, weight: 700},
  Title2:      {size: 93,  weight: 700},
  HeadlineXL:  {size: 62,  weight: 700},
  Headline1:   {size: 54,  weight: 700},
  Headline2:   {size: 48,  weight: 700},
  Subheadline: {size: 41,  weight: 700},
  Button:      {size: 39,  weight: 500},
  Callout:     {size: 39,  weight: 700},
  Body:        {size: 39,  weight: 500},
  Caption:     {size: 38,  weight: 500}
};

/** Panels sit at ~45cm, but the scale is calibrated at 110cm. */
const PANEL_DISTANCE = 45;

/**
 * Type is sized as if the panel were slightly further away than it is, which
 * renders it ~25% larger than strict angular parity. That margin is what keeps
 * labels readable at a 30-degree off-axis glance, where glyphs foreshorten.
 */
const TEXT_DISTANCE = PANEL_DISTANCE * 1.25;

function roleSize(role: TextRole, distanceCm: number = TEXT_DISTANCE): number {
  return TYPE_SCALE[role].size * FONT_SIZE_SCALE * (distanceCm / 110);
}

/** Shelf labels get one line; longer names are elided rather than wrapped. */
function trimName(name: string): string {
  if (!name) return "";
  return name.length > 11 ? name.substring(0, 10) + "\u2026" : name;
}

function applyTextRole(t: Text, role: TextRole, distanceCm: number = TEXT_DISTANCE): void {
  t.size = roleSize(role, distanceCm);
  (t as Text & {weight?: number}).weight = TYPE_SCALE[role].weight;
}

// ── Z lifts ──────────────────────────────────────────────────────────────────
const PANEL_CONTENT_Z_LIFT = 0.6;
const LAYOUT_Z_LIFT = 0.02;
const BUTTON_LABEL_Z = 0.08;
const ICON_Z = 0.1;

// ── Geometry ─────────────────────────────────────────────────────────────────
const WHEEL_PANEL_W = 19.0;
const SIDE_PANEL_W = 13.0;
const PAD = 1.1;
const ROW_H = 2.6;
const DEG = Math.PI / 180;

/**
 * Usable width inside the padding. Rows MUST be given an explicit width: a
 * FlexLayout left at width = -1 grows unbounded, and because the BackPlate is
 * sized from onLayoutComplete the whole panel inflates with it (observed: a
 * 19 cm panel measuring 287 cm across).
 */
const WHEEL_INNER_W = WHEEL_PANEL_W - PAD * 2;
// Six slots across the same width as the wheel panel. SHELF_VISIBLE in
// ShelfStore is the authority on the count; this must match it.
const SHELF_SLOTS = 6;
const SHELF_SLOT_W = 2.85;
const SHELF_SLOT_H = 5.4;
const SHELF_POT_H = 3.1;
const SIDE_INNER_W = SIDE_PANEL_W - PAD * 2;

@component
export class WheelStudioUI extends BaseScriptComponent {
  @ui.label("WHEEL Studio UI")
  @ui.separator
  @ui.group_start("Layout")
  @input
  @hint("Distance from the user to each station panel, in centimetres.")
  @widget(new SliderWidget(25, 90, 1))
  stationDistance: number = 45;

  @input
  @hint("Arc half-angle: the side stations sit this many degrees left and right of centre.")
  @widget(new SliderWidget(20, 90, 5))
  stationSpreadDeg: number = 60;

  @input
  @hint("Height of the side station panels relative to eye level, in centimetres.")
  @widget(new SliderWidget(-45, 10, 1))
  stationHeight: number = -19;

  @input
  @hint("Upward pitch of the wheel control panel so it faces the user from below.")
  @widget(new SliderWidget(0, 60, 1))
  wheelPanelPitchDeg: number = 24;
  @ui.group_end

  /**
   * Fills are SATURATED rather than pale. On an additive display a glyph can
   * only add light, so near-white text over a near-white fill is unreadable --
   * contrast has to come from the fill being strongly hued and the text being
   * whiter than it, never from a dark-on-light relationship.
   */
  @ui.group_start("Palette (waveguide: bright + saturated only)")
  @input
  @hint("Wheel panel fill. Bright and translucent - black would render invisible.")
  @widget(new ColorWidget())
  wheelFill: vec4 = new vec4(1.0, 0.60, 0.20, 0.50);

  @input
  @hint("Glaze bench panel fill.")
  @widget(new ColorWidget())
  glazeFill: vec4 = new vec4(0.15, 0.80, 1.0, 0.50);

  @input
  @hint("Kiln panel fill.")
  @widget(new ColorWidget())
  kilnFill: vec4 = new vec4(1.0, 0.36, 0.22, 0.52);

  @input
  @hint("Shelf panel fill. Cooler than the three working stations - finished work is not part of the active loop.")
  @widget(new ColorWidget())
  shelfFill: vec4 = new vec4(0.62, 0.42, 1.0, 0.46);

  @input
  @hint("Panel edge colour. Brighter than the fill so the panel reads as a solid object.")
  @widget(new ColorWidget())
  panelEdge: vec4 = new vec4(1.0, 0.93, 0.78, 0.85);

  @input
  @hint("Primary text. Near-white so it out-luminates the fill behind it.")
  @widget(new ColorWidget())
  textPrimary: vec4 = new vec4(1, 1, 1, 1);

  @input
  @hint("Secondary text - warm near-white, still high luminance.")
  @widget(new ColorWidget())
  textSecondary: vec4 = new vec4(1, 0.97, 0.91, 0.86);

  @input
  @hint("Live numeric readouts. Saturated mint reads clearly against the warm fill.")
  @widget(new ColorWidget())
  textValue: vec4 = new vec4(0.60, 1.0, 0.80, 1);

  @input
  @hint("Button face. Kept low-alpha: the button sits ON the panel and the two fills ADD, so a strong button would out-glow its own white label.")
  @widget(new ColorWidget())
  buttonFill: vec4 = new vec4(1.0, 0.46, 0.06, 0.34);

  @input
  @hint("Button face while hovered or pressed.")
  @widget(new ColorWidget())
  buttonHot: vec4 = new vec4(1.0, 0.70, 0.24, 0.60);

  @input
  @hint("Slider groove.")
  @widget(new ColorWidget())
  sliderTrack: vec4 = new vec4(1.0, 0.66, 0.26, 0.40);

  @input
  @hint("Filled portion of the slider - saturated so the current value reads at a glance.")
  @widget(new ColorWidget())
  sliderFill: vec4 = new vec4(0.25, 1.0, 0.68, 0.92);

  @input
  @hint("Slider knob. Near-white: it must out-luminate the fill it sits on.")
  @widget(new ColorWidget())
  sliderKnob: vec4 = new vec4(1.0, 1.0, 0.97, 1.0);

  @input
  @hint("Outline colour of the action buttons. Their faces are transparent, so this border and the label are the only lit pixels in the cell.")
  @widget(new ColorWidget())
  buttonBorder: vec4 = new vec4(1.0, 0.62, 0.16, 1.0);

  @input
  @hint("Action button outline while hovered or pressed.")
  @widget(new ColorWidget())
  buttonBorderHot: vec4 = new vec4(0.35, 1.0, 0.72, 1.0);
  @ui.group_end

  @input
  @hint("GlazeMat. Cloned per shelf pot so each miniature keeps its own recipe.")
  glazeMaterial: Material;

  @ui.group_start("Labels")
  @input @hint("Title of the centre station.") wheelTitle: string = "THE WHEEL";
  @input @hint("Title of the right-hand station.") glazeTitle: string = "THE GLAZE BENCH";
  @input @hint("Title of the left-hand station.") kilnTitle: string = "THE KILN";
  @input @hint("Title of the shelf overhead.") shelfTitle: string = "THE SHELF";
  @ui.group_end

  // ── Events (UI -> wiring) ──────────────────────────────────────────────────
  private _onTwist = new Event<number>();
  private _onFluteDepth = new Event<number>();
  private _onFluteCount = new Event<number>();
  private _onUndo = new Event<void>();
  private _onReset = new Event<void>();
  private _onGlaze = new Event<void>();
  private _onGlazeMicDown = new Event<void>();
  private _onGlazeMicUp = new Event<void>();
  private _onFire = new Event<void>();
  private _onShelfPick = new Event<number>();
  private _onVoiceThrowDown = new Event<void>();
  private _onVoiceThrowUp = new Event<void>();

  /** Normalised 0..1; the wiring maps it to radians. */
  get onTwistChanged(): PublicApi<number> { return this._onTwist.publicApi(); }
  /** Already in flute-depth units (0..0.35). */
  get onFluteDepthChanged(): PublicApi<number> { return this._onFluteDepth.publicApi(); }
  /** Integer 3..12. */
  get onFluteCountChanged(): PublicApi<number> { return this._onFluteCount.publicApi(); }
  get onUndo(): PublicApi<void> { return this._onUndo.publicApi(); }
  get onReset(): PublicApi<void> { return this._onReset.publicApi(); }
  get onGlaze(): PublicApi<void> { return this._onGlaze.publicApi(); }
  /** Mic button pressed on the Glaze Bench - start listening. */
  get onGlazeMicDown(): PublicApi<void> { return this._onGlazeMicDown.publicApi(); }
  /** Mic button released - stop listening and use the transcript. */
  get onGlazeMicUp(): PublicApi<void> { return this._onGlazeMicUp.publicApi(); }
  /** FIRE pressed on the Kiln. */
  get onFire(): PublicApi<void> { return this._onFire.publicApi(); }
  /** A shelf pot was pinched. Payload is its index in the displayed row. */
  get onShelfPick(): PublicApi<number> { return this._onShelfPick.publicApi(); }
  /** THROW WITH VOICE pressed — start listening. */
  get onVoiceThrowDown(): PublicApi<void> { return this._onVoiceThrowDown.publicApi(); }
  /** THROW WITH VOICE released — stop and shape. */
  get onVoiceThrowUp(): PublicApi<void> { return this._onVoiceThrowUp.publicApi(); }

  // ── State ─────────────────────────────────────────────────────────────────
  private fluteCount = 6;
  private twistSlider: Slider = null;
  private depthSlider: Slider = null;
  private twistValueText: Text = null;
  private depthValueText: Text = null;
  private countValueText: Text = null;
  private glazeTranscriptText: Text = null;
  private glazeStatusText: Text = null;
  private glazeStateText: Text = null;
  private kilnStateText: Text = null;
  private kilnStatusText: Text = null;
  private shelfSlots: {root: SceneObject; pot: ShelfPot; label: Text; button: Button}[] = [];
  private shelfPieces: ShelfPiece[] = [];
  private shelfEmptyText: Text = null;
  private shelfNoteText: Text = null;
  private voiceStatusText: Text = null;
  private lastGlazeName = "Celadon Crackle";
  private wheelControls: Slider[] = [];
  private wheelButtons: Button[] = [];

  static readonly FLUTE_DEPTH_MAX = 0.35;
  static readonly FLUTE_COUNT_MIN = 3;
  static readonly FLUTE_COUNT_MAX = 12;

  onAwake(): void {
    this.sceneObject.createComponent("Component.Canvas");
    this.createEvent("OnStartEvent").bind(() => {
      this.buildStations();
    });
  }

  // ── Public API (wiring -> UI) ─────────────────────────────────────────────

  /** Push state back into the panel, e.g. after an undo or reset. */
  setTwist(normalised: number): void {
    const v = this.clamp01(normalised);
    if (this.twistSlider) this.twistSlider.updateCurrentValue(v, false);
    if (this.twistValueText) this.twistValueText.text = this.fmt2(v);
  }

  setFluteDepth(depth: number): void {
    const d = Math.max(0, Math.min(WheelStudioUI.FLUTE_DEPTH_MAX, depth));
    if (this.depthSlider) {
      this.depthSlider.updateCurrentValue(d / WheelStudioUI.FLUTE_DEPTH_MAX, false);
    }
    if (this.depthValueText) this.depthValueText.text = this.fmt2(d);
  }

  setFluteCount(count: number): void {
    this.fluteCount = this.clampCount(count);
    if (this.countValueText) this.countValueText.text = String(this.fluteCount);
  }

  /** Live transcript, written on every ASR partial so the user sees they are heard. */
  setGlazeTranscript(text: string): void {
    if (this.glazeStatusText === null) return;
    this.glazeTranscriptText.text = text && text.length > 0 ? text : "\u2014";
  }

  /** Status line: listening / thinking / applied / offline reason. */
  setGlazeStatus(text: string): void {
    if (this.glazeStatusText === null) return;
    this.glazeStatusText.text = text;
  }

  /** WET before a glaze is applied, GLAZED after. */
  setGlazeState(state: string): void {
    if (this.glazeStateText === null) return;
    this.glazeStateText.text = state;
    this.glazeStateText.textFill.color =
      state === "GLAZED" ? this.textValue : this.textSecondary;
  }

  setKilnState(state: string): void {
    if (this.kilnStateText === null) return;
    this.kilnStateText.text = state;
    this.kilnStateText.textFill.color =
      state === "FIRED" ? this.textValue : this.textSecondary;
  }

  setKilnStatus(text: string): void {
    if (this.kilnStatusText !== null) this.kilnStatusText.text = text;
  }

  /** Name of the glaze currently on the pot; feeds the firing seed. */
  getGlazeName(): string {
    return this.lastGlazeName;
  }

  setGlazeName(name: string): void {
    if (name && name.length > 0) this.lastGlazeName = name;
  }

  /**
   * Lock the wheel controls once the piece is fired. Sliders go inactive and
   * the action buttons stop responding - fired clay cannot be reshaped.
   */
  setWheelControlsEnabled(enabled: boolean): void {
    for (let i = 0; i < this.wheelControls.length; i++) {
      (this.wheelControls[i] as any).inactive = !enabled;
    }
    for (let i = 0; i < this.wheelButtons.length; i++) {
      (this.wheelButtons[i] as any).inactive = !enabled;
    }
  }

  /** One line of voice-throw feedback under the wheel controls. */
  /**
   * The wheel panel's single status line. Voice throwing and UNDO both write
   * here; whichever spoke last wins, which is the right behaviour for a line
   * that reports what just happened.
   */
  setWheelStatus(msg: string): void {
    if (this.voiceStatusText) this.voiceStatusText.text = msg;
  }

  /** Alias kept so VoiceThrow reads naturally at its call site. */
  setVoiceStatus(msg: string): void {
    this.setWheelStatus(msg);
  }

  /**
   * Render the shelf row. Each slot builds a real miniature of the stored
   * profile in that piece's own glaze, so the potter recognises their work by
   * its silhouette. Slots past the end of the list are hidden, not blanked.
   */
  setShelfPieces(pieces: ShelfPiece[]): void {
    this.shelfPieces = pieces || [];
    const n = Math.min(this.shelfPieces.length, this.shelfSlots.length);
    for (let i = 0; i < this.shelfSlots.length; i++) {
      const slot = this.shelfSlots[i];
      const has = i < n;
      slot.root.enabled = has;
      if (!has) continue;
      const piece = this.shelfPieces[i];
      slot.pot.setPiece(piece);
      slot.label.text = trimName(piece.name);
    }
    if (this.shelfEmptyText) this.shelfEmptyText.enabled = n === 0;
    // The note belongs to the newest piece; it is the one the user just made.
    if (this.shelfNoteText) {
      const newest = n > 0 ? this.shelfPieces[0] : null;
      this.shelfNoteText.text = newest && newest.note ? newest.note : "";
    }
  }

  // ── Station construction ──────────────────────────────────────────────────

  private buildStations(): void {
    const d = this.stationDistance;
    const spread = this.stationSpreadDeg * DEG;

    // Centre: the control panel sits BELOW the vessel and pitches up toward the
    // user, so it never occludes the silhouette being shaped.
    const wheelRoot = this.obj(this.sceneObject, "Station_Wheel",
      new vec3(0, -44, -(d * 0.92)));
    wheelRoot.getTransform().setLocalRotation(
      quat.angleAxis(this.wheelPanelPitchDeg * DEG, vec3.right()));
    this.buildWheelPanel(wheelRoot);

    // Right / left stations on the arc, each yawed to face the user at origin.
    const rx = Math.sin(spread) * d;
    const rz = -Math.cos(spread) * d;

    const glazeRoot = this.obj(this.sceneObject, "Station_Glaze",
      new vec3(rx, this.stationHeight, rz));
    glazeRoot.getTransform().setLocalRotation(quat.angleAxis(-spread, vec3.up()));
    this.buildGlazeBench(glazeRoot);

    // The shelf sits above the wheel, tilted down: finished work lives overhead,
    // out of the way of the piece being thrown.
    const shelfRoot = this.obj(this.sceneObject, "Station_Shelf",
      new vec3(0, 12, -(d * 0.95)));
    shelfRoot.getTransform().setLocalRotation(
      quat.angleAxis(-14 * DEG, vec3.right()));
    this.buildShelf(shelfRoot);

    const kilnRoot = this.obj(this.sceneObject, "Station_Kiln",
      new vec3(-rx, this.stationHeight, rz));
    kilnRoot.getTransform().setLocalRotation(quat.angleAxis(spread, vec3.up()));
    this.buildKiln(kilnRoot);
  }

  private buildWheelPanel(root: SceneObject): void {
    const plate = this.plate(root, this.wheelFill);
    const content = this.obj(root, "Content", new vec3(0, 0, PANEL_CONTENT_Z_LIFT));

    const col = content.createComponent(FlexLayout.getTypeName()) as FlexLayout;
    // addItems() throws if the layout would also auto-discover its children and
    // has not initialized yet. We register every child explicitly via flexChild,
    // so turn auto-discovery off up front.
    col.autoDiscoverItemsOnStart = false;
    col.onInitialized.add(() => {
      col.width = WHEEL_PANEL_W;
      col.height = -1;
      col.direction = FlexDirection.Column;
      col.alignItems = FlexAlign.Stretch;
      col.rowGap = 0.75;
      col.paddingTop = PAD;
      col.paddingBottom = PAD;
      col.paddingLeft = PAD;
      col.paddingRight = PAD;
    });
    col.onLayoutComplete.add((r) => {
      plate.size = new vec2(r.containerWidth, r.containerHeight);
    });

    this.header(content, this.wheelTitle, ICON_WHEEL, WHEEL_INNER_W);
    this.twistSlider = this.sliderRow(content, "TWIST", 0, (v) => {
      if (this.twistValueText) this.twistValueText.text = this.fmt2(v);
      this._onTwist.invoke(v);
    }, (t) => { this.twistValueText = t; });

    this.depthSlider = this.sliderRow(content, "FLUTE DEPTH", 0, (v) => {
      const depth = v * WheelStudioUI.FLUTE_DEPTH_MAX;
      if (this.depthValueText) this.depthValueText.text = this.fmt2(depth);
      this._onFluteDepth.invoke(depth);
    }, (t) => { this.depthValueText = t; });

    this.stepperRow(content, "FLUTE COUNT");
    this.buttonRow(content);
  }

  /**
   * The Glaze Bench is the one interactive side station: hold the mic, speak a
   * glaze, release. Transcript and status are separate lines so a failed
   * network call can explain itself without erasing what the user said.
   */
  private buildGlazeBench(root: SceneObject): void {
    const plate = this.plate(root, this.glazeFill);
    const content = this.obj(root, "Content", new vec3(0, 0, PANEL_CONTENT_Z_LIFT));

    const col = content.createComponent(FlexLayout.getTypeName()) as FlexLayout;
    col.autoDiscoverItemsOnStart = false;
    col.onInitialized.add(() => {
      col.width = SIDE_PANEL_W;
      col.height = -1;
      col.direction = FlexDirection.Column;
      col.alignItems = FlexAlign.Stretch;
      col.rowGap = 0.55;
      col.paddingTop = PAD;
      col.paddingBottom = PAD;
      col.paddingLeft = PAD;
      col.paddingRight = PAD;
    });
    col.onLayoutComplete.add((r) => {
      plate.size = new vec2(r.containerWidth, r.containerHeight);
    });

    this.header(content, this.glazeTitle, ICON_GLAZE, SIDE_INNER_W);

    // State chip
    this.flexChild(content, {w: SIDE_INNER_W, h: 1.9}, (row) => {
      this.glazeStateText = this.rowText(row, "WET", "Callout", SIDE_INNER_W,
        this.textSecondary, HorizontalAlignment.Left);
    });

    // Live transcript
    this.flexChild(content, {w: SIDE_INNER_W, h: 2.2}, (row) => {
      this.glazeTranscriptText = this.rowText(row, "\u2014", "Caption", SIDE_INNER_W,
        this.textPrimary, HorizontalAlignment.Left);
    });

    // Status line
    this.flexChild(content, {w: SIDE_INNER_W, h: 1.9}, (row) => {
      this.glazeStatusText = this.rowText(row, "Hold the mic and describe a glaze",
        "Caption", SIDE_INNER_W, this.textSecondary, HorizontalAlignment.Left);
    });

    // Hold-to-talk. Element exposes onTriggerDown/onTriggerUp for hold; the
    // onTriggerStart/End pair does not exist here and would silently no-op.
    this.flexChild(content, {w: SIDE_INNER_W, h: 3.0}, (rowObj) => {
      const row = this.flexRow(rowObj, SIDE_INNER_W, 3.0, {
        gap: 0.4, justify: FlexJustify.Center, align: FlexAlign.Center
      });
      this.flexChild(row, {w: 9.4, h: 2.6}, (btnObj) => {
        const btn = btnObj.createComponent(Button.getTypeName()) as Button;
        btn.onInitialized.add(() => {
          btn.size = new vec3(9.4, 2.6, 1);
          this.outlineVisual(btn.visual as RoundedRectangleVisual,
            this.buttonBorder, this.buttonBorderHot);
        });
        const labelObj = this.obj(btnObj, "MicLabel", new vec3(0, 0, BUTTON_LABEL_Z));
        const t = labelObj.createComponent("Component.Text") as Text;
        t.text = "HOLD TO SPEAK";
        t.font = THEME_FONT;
        t.depthTest = true;
        applyTextRole(t, "Button");
        t.textFill.color = this.textPrimary;
        t.horizontalAlignment = HorizontalAlignment.Center;
        t.verticalAlignment = VerticalAlignment.Center;
        t.horizontalOverflow = HorizontalOverflow.Overflow;
        t.verticalOverflow = VerticalOverflow.Overflow;
        t.layoutRect = Rect.create(-4.45, 4.45, -1.2, 1.2);
        btn.onTriggerDown.add(() => this._onGlazeMicDown.invoke());
        btn.onTriggerUp.add(() => this._onGlazeMicUp.invoke());
      });
    });
  }

  /** Kiln: state chip, the firing readout, and the FIRE button. */
  private buildKiln(root: SceneObject): void {
    const plate = this.plate(root, this.kilnFill);
    const content = this.obj(root, "Content", new vec3(0, 0, PANEL_CONTENT_Z_LIFT));

    const col = content.createComponent(FlexLayout.getTypeName()) as FlexLayout;
    col.autoDiscoverItemsOnStart = false;
    col.onInitialized.add(() => {
      col.width = SIDE_PANEL_W;
      col.height = -1;
      col.direction = FlexDirection.Column;
      col.alignItems = FlexAlign.Stretch;
      col.rowGap = 0.55;
      col.paddingTop = PAD;
      col.paddingBottom = PAD;
      col.paddingLeft = PAD;
      col.paddingRight = PAD;
    });
    col.onLayoutComplete.add((r) => {
      plate.size = new vec2(r.containerWidth, r.containerHeight);
    });

    this.header(content, this.kilnTitle, ICON_KILN, SIDE_INNER_W);

    this.flexChild(content, {w: SIDE_INNER_W, h: 1.9}, (row) => {
      this.kilnStateText = this.rowText(row, "COLD", "Callout", SIDE_INNER_W,
        this.textSecondary, HorizontalAlignment.Left);
    });

    // The firing readout carries the seed, so a result the user liked can be
    // reproduced later - the seed IS the recipe.
    this.flexChild(content, {w: SIDE_INNER_W, h: 2.2}, (row) => {
      this.kilnStatusText = this.rowText(row, "Ready to fire", "Caption",
        SIDE_INNER_W, this.textPrimary, HorizontalAlignment.Left);
    });

    this.flexChild(content, {w: SIDE_INNER_W, h: 3.0}, (rowObj) => {
      const row = this.flexRow(rowObj, SIDE_INNER_W, 3.0, {
        gap: 0.4, justify: FlexJustify.Center, align: FlexAlign.Center
      });
      this.flexChild(row, {w: 7.0, h: 2.6}, (btnObj) => {
        const btn = btnObj.createComponent(Button.getTypeName()) as Button;
        btn.onInitialized.add(() => {
          btn.size = new vec3(7.0, 2.6, 1);
          this.outlineVisual(btn.visual as RoundedRectangleVisual,
            this.buttonBorder, this.buttonBorderHot);
        });
        const labelObj = this.obj(btnObj, "FireLabel", new vec3(0, 0, BUTTON_LABEL_Z));
        const t = labelObj.createComponent("Component.Text") as Text;
        t.text = "FIRE";
        t.font = THEME_FONT;
        t.depthTest = true;
        applyTextRole(t, "Button");
        t.textFill.color = this.textPrimary;
        t.horizontalAlignment = HorizontalAlignment.Center;
        t.verticalAlignment = VerticalAlignment.Center;
        t.horizontalOverflow = HorizontalOverflow.Overflow;
        t.verticalOverflow = VerticalOverflow.Overflow;
        t.layoutRect = Rect.create(-3.25, 3.25, -1.2, 1.2);
        btn.onTriggerUp.add(() => this._onFire.invoke());
      });
    });
  }

  /**
   * The shelf: a row of finished pots the user can pinch to put back on the
   * wheel. Laid out by hand rather than with FlexLayout because the slots hold
   * lathe meshes, and FlexItem only measures 2D UI elements - a mesh child
   * reports no size and the row collapses.
   */
  private buildShelf(root: SceneObject): void {
    const plate = this.plate(root, this.shelfFill);
    const panelH = SHELF_SLOT_H + ROW_H * 1.15 + 4.2 + PAD * 2;
    plate.onInitialized.add(() => {
      plate.size = new vec2(WHEEL_PANEL_W, panelH);
    });

    const content = this.obj(root, "Content", new vec3(0, 0, PANEL_CONTENT_Z_LIFT));
    const topY = panelH / 2 - PAD;

    this.freeText(content, this.shelfTitle, "Subheadline", this.textPrimary,
      new vec3(0, topY - ROW_H * 0.55, 0), WHEEL_INNER_W, HorizontalAlignment.Center);

    // Empty state. Overlays the row area; hidden as soon as a piece exists.
    this.shelfEmptyText = this.freeText(content, "Nothing fired yet", "Caption",
      this.textSecondary, new vec3(0, topY - ROW_H * 1.15 - SHELF_SLOT_H / 2, 0),
      WHEEL_INNER_W, HorizontalAlignment.Center);

    const rowY = topY - ROW_H * 1.15 - SHELF_SLOT_H / 2;
    const pitch = WHEEL_INNER_W / SHELF_SLOTS;
    for (let i = 0; i < SHELF_SLOTS; i++) {
      const x = (i - (SHELF_SLOTS - 1) / 2) * pitch;
      const slotObj = this.obj(content, "Slot" + i, new vec3(x, rowY, 0));

      const btn = slotObj.createComponent(Button.getTypeName()) as Button;
      btn.onInitialized.add(() => {
        btn.size = new vec3(SHELF_SLOT_W, SHELF_SLOT_H, 1);
        // Kill the button's own plate. Its gradient assignment does not take on
        // these cells and the fallback is UIKit's near-black, which is a hole
        // in the world on the waveguide. The collider is a separate child, so
        // dropping the visual costs the hit target nothing.
        const rr = slotObj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (rr) rr.enabled = false;
      });

      // The pot sits in front of the cell and is anchored by its foot, so pots
      // of different heights all stand on the same shelf line rather than
      // floating centred.
      const potHost = this.obj(slotObj, "Pot",
        new vec3(0, -SHELF_SLOT_H / 2 + 1.15, ICON_Z));
      const pot = new ShelfPot(potHost, this.glazeMaterial, SHELF_POT_H);

      const label = this.freeText(slotObj, "", "Caption", this.textSecondary,
        new vec3(0, -SHELF_SLOT_H / 2 - 0.55, BUTTON_LABEL_Z),
        SHELF_SLOT_W + 0.5, HorizontalAlignment.Center);

      // Hover feedback in light rather than in a frame: the label goes bright
      // and the pot swells. Nothing here can paint a dark pixel.
      const potTr = potHost.getTransform();
      btn.onHoverEnter.add(() => {
        label.textFill.color = this.buttonBorderHot;
        potTr.setLocalScale(new vec3(1.14, 1.14, 1.14));
      });
      btn.onHoverExit.add(() => {
        label.textFill.color = this.textSecondary;
        potTr.setLocalScale(vec3.one());
      });

      const index = i;
      btn.onTriggerUp.add(() => {
        if (index < this.shelfPieces.length) this._onShelfPick.invoke(index);
      });

      slotObj.enabled = false;
      this.shelfSlots.push({root: slotObj, pot: pot, label: label, button: btn});
    }

    // The critique for the newest piece. Two lines of room; empty when the
    // naming call failed, which is the documented "hide the note" behaviour.
    this.shelfNoteText = this.freeText(content, "", "Caption", this.textSecondary,
      new vec3(0, -panelH / 2 + PAD + 1.0, 0), WHEEL_INNER_W, HorizontalAlignment.Center);
  }

  /**
   * Text placed at an explicit local position rather than by a layout. Used
   * where a FlexLayout would be the wrong tool - see buildShelf.
   */
  private freeText(parent: SceneObject, text: string, role: TextRole, color: vec4,
      pos: vec3, widthCm: number, align: HorizontalAlignment): Text {
    const so = this.obj(parent, "Text", pos);
    const t = so.createComponent("Component.Text") as Text;
    t.text = text;
    t.font = THEME_FONT;
    t.depthTest = true;
    applyTextRole(t, role);
    t.textFill.color = color;
    t.horizontalAlignment = align;
    t.verticalAlignment = VerticalAlignment.Center;
    t.horizontalOverflow = HorizontalOverflow.Wrap;
    t.verticalOverflow = VerticalOverflow.Overflow;
    t.layoutRect = Rect.create(-widthCm / 2, widthCm / 2, -1.1, 1.1);
    return t;
  }

  private buildStationMarker(root: SceneObject, title: string, icon: Texture,
      fill: vec4, subtitle: string): void {
    const plate = this.plate(root, fill);
    const content = this.obj(root, "Content", new vec3(0, 0, PANEL_CONTENT_Z_LIFT));

    const col = content.createComponent(FlexLayout.getTypeName()) as FlexLayout;
    // addItems() throws if the layout would also auto-discover its children and
    // has not initialized yet. We register every child explicitly via flexChild,
    // so turn auto-discovery off up front.
    col.autoDiscoverItemsOnStart = false;
    col.onInitialized.add(() => {
      col.width = SIDE_PANEL_W;
      col.height = -1;
      col.direction = FlexDirection.Column;
      col.alignItems = FlexAlign.Stretch;
      col.rowGap = 0.6;
      col.paddingTop = PAD;
      col.paddingBottom = PAD;
      col.paddingLeft = PAD;
      col.paddingRight = PAD;
    });
    col.onLayoutComplete.add((r) => {
      plate.size = new vec2(r.containerWidth, r.containerHeight);
    });

    this.header(content, title, icon, SIDE_INNER_W);
    this.flexChild(content, {w: SIDE_INNER_W, h: ROW_H * 0.8}, (row) => {
      this.stretchText(row, subtitle, "Caption", this.textSecondary);
    });
  }

  // ── Rows ──────────────────────────────────────────────────────────────────

  private header(content: SceneObject, title: string, icon: Texture, innerW: number): void {
    const labelW = innerW - 2.2 - 0.6;
    this.flexChild(content, {w: innerW, h: ROW_H * 1.15}, (headerObj) => {
      const row = this.flexRow(headerObj, innerW, ROW_H * 1.15, {
        gap: 0.6, justify: FlexJustify.Start, align: FlexAlign.Center
      });
      this.flexChild(row, {w: 2.2, h: 2.2}, (iconObj) => {
        this.icon(iconObj, icon, 2.2, this.textPrimary);
      });
      this.flexChild(row, {w: labelW, h: 2.4}, (labelObj) => {
        this.rowText(labelObj, title, "Headline2", labelW, this.textPrimary,
          HorizontalAlignment.Left);
      });
    });
  }

  private sliderRow(content: SceneObject, label: string, initial: number,
      onChange: (v: number) => void, captureText: (t: Text) => void): Slider {
    let slider: Slider = null;
    this.flexChild(content, {w: WHEEL_INNER_W, h: ROW_H}, (rowObj) => {
      const row = this.flexRow(rowObj, WHEEL_INNER_W, ROW_H, {
        gap: 0.5, justify: FlexJustify.SpaceBetween, align: FlexAlign.Center
      });

      this.flexChild(row, {w: 5.0, h: 2.0}, (labelObj) => {
        this.rowText(labelObj, label, "Subheadline", 5.0, this.textSecondary,
          HorizontalAlignment.Left);
      });

      this.flexChild(row, {w: 8.0, h: 1.5}, (sliderObj) => {
        const s = sliderObj.createComponent(Slider.getTypeName()) as Slider;
        // Slider (like Switch) needs its size before initialize(), or the fill
        // and knob render at the default width until the first drag.
        (s as Slider & {_size?: vec3})._size = new vec3(8.0, 1.5, 1);
        s.initialize();
        s.updateCurrentValue(initial, false);
        this.themeVisual(s.visual as RoundedRectangleVisual, this.sliderTrack, this.sliderTrack);
        this.themeVisual(s.trackFillVisual as RoundedRectangleVisual, this.sliderFill, this.sliderFill);
        this.themeVisual(s.knobVisual as RoundedRectangleVisual, this.sliderKnob, this.sliderKnob);
        s.onValueChange.add((v: number) => onChange(v));
        slider = s;
        this.wheelControls.push(s);
      });

      this.flexChild(row, {w: 2.6, h: 2.0}, (valueObj) => {
        const t = this.rowText(valueObj, this.fmt2(initial), "Callout", 2.6,
          this.textValue, HorizontalAlignment.Right);
        captureText(t);
      });
    });
    return slider;
  }

  private stepperRow(content: SceneObject, label: string): void {
    this.flexChild(content, {w: WHEEL_INNER_W, h: ROW_H}, (rowObj) => {
      const row = this.flexRow(rowObj, WHEEL_INNER_W, ROW_H, {
        gap: 0.5, justify: FlexJustify.SpaceBetween, align: FlexAlign.Center
      });

      this.flexChild(row, {w: 7.2, h: 2.0}, (labelObj) => {
        this.rowText(labelObj, label, "Subheadline", 7.2, this.textSecondary,
          HorizontalAlignment.Left);
      });

      this.flexChild(row, {w: 2.4, h: 2.4}, (minusCell) => {
        const minusObj = this.obj(minusCell, "MinusBtn");
        this.iconButton(minusObj, ICON_MINUS, 2.4, () => {
          this.setFluteCount(this.fluteCount - 1);
          this._onFluteCount.invoke(this.fluteCount);
        });
      });

      this.flexChild(row, {w: 2.4, h: 2.0}, (valueObj) => {
        this.countValueText = this.rowText(valueObj, String(this.fluteCount),
          "Callout", 2.4, this.textValue, HorizontalAlignment.Center);
      });

      this.flexChild(row, {w: 2.4, h: 2.4}, (plusCell) => {
        const plusObj = this.obj(plusCell, "PlusBtn");
        this.iconButton(plusObj, ICON_PLUS, 2.4, () => {
          this.setFluteCount(this.fluteCount + 1);
          this._onFluteCount.invoke(this.fluteCount);
        });
      });
    });
  }

  private buttonRow(content: SceneObject): void {
    this.flexChild(content, {w: WHEEL_INNER_W, h: 3.0}, (rowObj) => {
      const row = this.flexRow(rowObj, WHEEL_INNER_W, 3.0, {
        gap: 0.45, justify: FlexJustify.SpaceBetween, align: FlexAlign.Center
      });
      this.textButton(row, "UNDO", 4.8, () => this._onUndo.invoke());
      this.textButton(row, "RESET", 5.0, () => this._onReset.invoke());
      this.textButton(row, "GLAZE >", 5.8, () => this._onGlaze.invoke());
    });

    // Hold-to-hum. Same onTriggerDown/Up pair the glaze mic uses - Element
    // exposes those for a hold; onTriggerStart/End belong to Interactable and
    // would silently no-op here.
    this.flexChild(content, {w: WHEEL_INNER_W, h: 3.0}, (rowObj) => {
      const row = this.flexRow(rowObj, WHEEL_INNER_W, 3.0, {
        gap: 0.4, justify: FlexJustify.Center, align: FlexAlign.Center
      });
      this.flexChild(row, {w: 13.0, h: 2.6}, (btnObj) => {
        const btn = btnObj.createComponent(Button.getTypeName()) as Button;
        btn.onInitialized.add(() => {
          btn.size = new vec3(13.0, 2.6, 1);
          this.outlineVisual(btn.visual as RoundedRectangleVisual,
            this.buttonBorder, this.buttonBorderHot);
        });
        const labelObj = this.obj(btnObj, "VoiceLabel", new vec3(0, 0, BUTTON_LABEL_Z));
        const t = labelObj.createComponent("Component.Text") as Text;
        t.text = "THROW WITH VOICE";
        t.font = THEME_FONT;
        t.depthTest = true;
        applyTextRole(t, "Button");
        t.textFill.color = this.textPrimary;
        t.horizontalAlignment = HorizontalAlignment.Center;
        t.verticalAlignment = VerticalAlignment.Center;
        t.horizontalOverflow = HorizontalOverflow.Overflow;
        t.verticalOverflow = VerticalOverflow.Overflow;
        t.layoutRect = Rect.create(-6.25, 6.25, -1.2, 1.2);
        btn.onTriggerDown.add(() => this._onVoiceThrowDown.invoke());
        btn.onTriggerUp.add(() => this._onVoiceThrowUp.invoke());
        this.wheelButtons.push(btn);
      });
    });

    this.flexChild(content, {w: WHEEL_INNER_W, h: 1.9}, (row) => {
      this.voiceStatusText = this.rowText(row, "Hold and hum to throw a shape",
        "Caption", WHEEL_INNER_W, this.textSecondary, HorizontalAlignment.Center);
    });
  }

  // ── Primitives ────────────────────────────────────────────────────────────

  /**
   * Repaint a UIKit visual bright. Solid colour is expressed as a two-stop
   * gradient of the same value because that is the only per-state base-colour
   * path RoundedRectangleVisual exposes publicly.
   */
  private themeVisual(v: RoundedRectangleVisual, base: vec4, hot: vec4): void {
    if (!v) return;
    const flat = (c: vec4): GradientParameters => ({
      stop0: {enabled: true, percent: 0, color: c},
      stop1: {enabled: true, percent: 1.0, color: c}
    } as GradientParameters);
    v.defaultBaseType = "Gradient";
    v.hoveredBaseType = "Gradient";
    v.triggeredBaseType = "Gradient";
    v.defaultGradient = flat(base);
    v.hoveredGradient = flat(hot);
    v.triggeredGradient = flat(hot);
  }

  /**
   * Outline-only treatment: fully transparent face plus a bright saturated
   * border. A button drawn ON the panel would otherwise ADD its fill to the
   * panel's, and the stack lands too close to the white label's luminance for
   * the label to read. With no face, the border and the glyphs are the only
   * lit pixels in the cell.
   */
  private outlineVisual(v: RoundedRectangleVisual, border: vec4, borderHot: vec4): void {
    if (!v) return;
    // A near-zero-alpha tint of the border hue rather than transparent BLACK.
    // Black is genuinely invisible on the waveguide, but in the Lens Studio
    // preview it composites as a dark rectangle, which reads as exactly the
    // dark panel the palette rule forbids. This keeps preview and device honest.
    const faint = new vec4(border.x, border.y, border.z, 0.05);
    // stop2/stop3 are explicitly disabled: leaving them unset lets whatever the
    // visual had before bleed through and the "outline" fills solid.
    const clear = (): GradientParameters => ({
      stop0: {enabled: true, percent: 0, color: faint},
      stop1: {enabled: true, percent: 1.0, color: faint},
      stop2: {enabled: false, percent: 1.0, color: faint},
      stop3: {enabled: false, percent: 1.0, color: faint}
    } as GradientParameters);
    v.defaultBaseType = "Gradient";
    v.hoveredBaseType = "Gradient";
    v.triggeredBaseType = "Gradient";
    v.defaultGradient = clear();
    v.hoveredGradient = clear();
    v.triggeredGradient = clear();
    v.defaultHasBorder = true;
    v.hoveredHasBorder = true;
    v.triggeredHasBorder = true;
    v.defaultBorderType = "Color";
    v.hoveredBorderType = "Color";
    v.triggeredBorderType = "Color";
    v.defaultBorderSize = 0.035;
    v.hoveredBorderSize = 0.055;
    v.triggeredBorderSize = 0.055;
    v.borderDefaultColor = border;
    v.borderHoveredColor = borderHot;
    v.borderTriggeredColor = borderHot;
  }

  /**
   * BackPlate retinted for the waveguide. UIKit's own default is near-black
   * (HSV value 0.09) which renders as a hole in the world on this display, so
   * the RoundedRectangle it creates on this SceneObject is repainted bright.
   */
  private plate(root: SceneObject, fill: vec4): BackPlate {
    const plate = root.createComponent(BackPlate.getTypeName()) as BackPlate;
    plate.style = "simple";
    plate.onInitialized.add(() => {
      const rr = root.getComponent(RoundedRectangle.getTypeName()) as RoundedRectangle;
      if (rr) {
        rr.backgroundColor = fill;
        rr.borderColor = this.panelEdge;
        rr.borderSize = 0.09;
      }
    });
    return plate;
  }

  private icon(parent: SceneObject, tex: Texture, sizeCm: number, tint: vec4): void {
    const so = this.obj(parent, "Icon", new vec3(0, 0, ICON_Z));
    const img = so.createComponent("Component.Image") as Image;
    const mat = IMAGE_MAT.clone();
    mat.mainPass.baseTex = tex;
    mat.mainPass.baseColor = tint;
    // Icons depth-test but never depth-write: their transparent margin would
    // otherwise punch a hole through siblings drawn later in the hierarchy.
    mat.mainPass.depthTest = true;
    mat.mainPass.depthWrite = false;
    img.clearMaterials();
    img.addMaterial(mat);
    // ImageHandler reads localScale as the image's size.
    so.getTransform().setLocalScale(new vec3(sizeCm, sizeCm, 1));
    so.createComponent(FlexItem.getTypeName());
  }

  private rowText(parent: SceneObject, text: string, role: TextRole, widthCM: number,
      color: vec4, align: HorizontalAlignment): Text {
    const so = this.obj(parent, "RowText");
    const t = so.createComponent("Component.Text") as Text;
    t.text = text;
    t.font = THEME_FONT;
    t.depthTest = true;
    applyTextRole(t, role);
    t.textFill.color = color;
    t.horizontalAlignment = align;
    t.verticalAlignment = VerticalAlignment.Center;
    t.horizontalOverflow = HorizontalOverflow.Overflow;
    t.verticalOverflow = VerticalOverflow.Overflow;
    t.layoutRect = Rect.create(-widthCM / 2, widthCM / 2, -1.2, 1.2);
    so.createComponent(FlexItem.getTypeName());
    return t;
  }

  /** Column-direction text: Stretch gives it the full cell width. */
  private stretchText(parent: SceneObject, text: string, role: TextRole, color: vec4): Text {
    const so = this.obj(parent, "Text");
    const t = so.createComponent("Component.Text") as Text;
    t.text = text;
    t.font = THEME_FONT;
    t.depthTest = true;
    applyTextRole(t, role);
    t.textFill.color = color;
    t.horizontalAlignment = HorizontalAlignment.Left;
    t.verticalAlignment = VerticalAlignment.Center;
    t.horizontalOverflow = HorizontalOverflow.Overflow;
    t.verticalOverflow = VerticalOverflow.Overflow;
    t.layoutRect = Rect.create(-0.5, 0.5, -0.5, 0.5);
    const fi = so.createComponent(FlexItem.getTypeName()) as FlexItem;
    fi.alignSelf = FlexAlignSelf.Stretch;
    return t;
  }

  private textButton(row: SceneObject, label: string, widthCm: number, onClick: () => void): void {
    this.flexChild(row, {w: widthCm, h: 2.6}, (btnObj) => {
      const btn = btnObj.createComponent(Button.getTypeName()) as Button;
      btn.onInitialized.add(() => {
        btn.size = new vec3(widthCm, 2.6, 1);
        this.outlineVisual(btn.visual as RoundedRectangleVisual,
          this.buttonBorder, this.buttonBorderHot);
      });
      const labelObj = this.obj(btnObj, "ButtonLabel", new vec3(0, 0, BUTTON_LABEL_Z));
      const t = labelObj.createComponent("Component.Text") as Text;
      t.text = label;
      t.font = THEME_FONT;
      t.depthTest = true;
      applyTextRole(t, "Button");
      t.textFill.color = this.textPrimary;
      t.horizontalAlignment = HorizontalAlignment.Center;
      t.verticalAlignment = VerticalAlignment.Center;
      t.horizontalOverflow = HorizontalOverflow.Overflow;
      t.verticalOverflow = VerticalOverflow.Overflow;
      t.layoutRect = Rect.create(-(widthCm - 0.5) / 2, (widthCm - 0.5) / 2, -1.2, 1.2);
      btn.onTriggerUp.add(onClick);
      this.wheelButtons.push(btn);
    });
  }

  private iconButton(parent: SceneObject, tex: Texture, sizeCm: number, onClick: () => void): void {
    const btn = parent.createComponent(Button.getTypeName()) as Button;
    btn.onInitialized.add(() => {
      btn.size = new vec3(sizeCm, sizeCm, 1);
      this.themeVisual(btn.visual as RoundedRectangleVisual, this.buttonFill, this.buttonHot);
    });
    const iconHost = this.obj(parent, "BtnIcon", new vec3(0, 0, BUTTON_LABEL_Z));
    this.icon(iconHost, tex, sizeCm * 0.62, this.textPrimary);
    btn.onTriggerUp.add(onClick);
  }

  // ── Layout helpers ────────────────────────────────────────────────────────

  private obj(parent: SceneObject, name: string, position?: vec3): SceneObject {
    const so = global.scene.createSceneObject(name);
    so.setParent(parent);
    if (position) so.getTransform().setLocalPosition(position);
    return so;
  }

  private liftInZ(so: SceneObject, zOffset: number): void {
    const tr = so.getTransform();
    const p = tr.getLocalPosition();
    tr.setLocalPosition(new vec3(p.x, p.y, p.z + zOffset));
  }

  private flexRow(parent: SceneObject, width: number, height: number,
      opts?: {gap?: number; padY?: number; padX?: number; justify?: FlexJustify; align?: FlexAlign}): SceneObject {
    const container = this.obj(parent, "Flex");
    this.liftInZ(container, LAYOUT_Z_LIFT);
    const flex = container.createComponent(FlexLayout.getTypeName()) as FlexLayout;
    flex.autoDiscoverItemsOnStart = false;
    const item = container.createComponent(FlexItem.getTypeName()) as FlexItem;
    if (width > 0) item.overrideWidth = width;
    if (height > 0) item.overrideHeight = height;
    flex.onInitialized.add(() => {
      flex.width = width;
      flex.height = height;
      flex.direction = FlexDirection.Row;
      flex.columnGap = opts?.gap ?? 0;
      flex.paddingTop = opts?.padY ?? 0;
      flex.paddingBottom = opts?.padY ?? 0;
      flex.paddingLeft = opts?.padX ?? 0;
      flex.paddingRight = opts?.padX ?? 0;
      flex.justifyContent = opts?.justify ?? FlexJustify.Start;
      flex.alignItems = opts?.align ?? FlexAlign.Stretch;
    });
    return container;
  }

  private flexChild(parent: SceneObject, size: {w?: number; h?: number; grow?: number},
      builder: (child: SceneObject) => void): SceneObject {
    const child = this.obj(parent, "Item");
    this.liftInZ(child, LAYOUT_Z_LIFT);
    const item = child.createComponent(FlexItem.getTypeName()) as FlexItem;
    if (size.w !== undefined && size.w > 0) item.overrideWidth = size.w;
    if (size.h !== undefined && size.h > 0) item.overrideHeight = size.h;
    item.flexGrow = size.grow ?? 0;
    item.flexShrink = 0;

    builder(child);

    const parentFlex = parent.getComponent(FlexLayout.getTypeName()) as FlexLayout | null;
    if (parentFlex) parentFlex.addItems([item]);
    return child;
  }

  // ── Small utils ───────────────────────────────────────────────────────────

  private clamp01(v: number): number {
    return !isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
  }

  private clampCount(v: number): number {
    const n = Math.round(v);
    if (!isFinite(n)) return WheelStudioUI.FLUTE_COUNT_MIN;
    if (n < WheelStudioUI.FLUTE_COUNT_MIN) return WheelStudioUI.FLUTE_COUNT_MIN;
    if (n > WheelStudioUI.FLUTE_COUNT_MAX) return WheelStudioUI.FLUTE_COUNT_MAX;
    return n;
  }

  private fmt2(v: number): string {
    const r = Math.round(v * 100) / 100;
    let s = String(r);
    if (s.indexOf(".") === -1) s = s + ".00";
    else if (s.split(".")[1].length === 1) s = s + "0";
    return s;
  }
}
