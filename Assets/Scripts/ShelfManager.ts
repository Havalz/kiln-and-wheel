/**
 * WHEEL - ShelfManager
 *
 * What happens to a pot after it comes out of the kiln: it gets a name, an
 * honest word about its proportions, and a place on the shelf that survives
 * closing the Lens.
 *
 * NAMING NEVER BLOCKS THE SHELF. The Gemini call is a nicety layered on top of
 * a save that has already happened. If it times out, errors, or answers with
 * something unparseable, the piece keeps a deterministic local name derived
 * from its own firing seed and the critique line is simply hidden. The same
 * 20-second ceiling as the glaze bench applies, armed here because
 * Gemini.models() has no timeout of its own.
 *
 * A stored piece is profile + glaze + seed. Because firing is a pure function
 * of the seed, reloading gives back the SAME pot rather than a lookalike.
 */

import {Gemini} from "RemoteServiceGateway.lspkg/HostedExternal/Gemini";
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event";

import {KilnStation} from "./KilnStation";
import {LatheMesher} from "./core/LatheMesher";
import {WheelStudioUI} from "./WheelStudioUI";
import {applyGlazeToPass} from "./core/GlazeApply";
import {
  NAME_SYSTEM_INSTRUCTION,
  addPiece,
  deserializeShelf,
  localName,
  parseNameReply,
  recentPieces,
  serializeShelf
} from "./core/ShelfStore";
import type {ShelfPiece} from "./core/ShelfStore";
import type {FiringResult} from "./core/FiringSeed";

/** Exported so tests address the same key rather than re-typing the literal. */
export const STORAGE_KEY = "wheel.shelf.v1";

@component
export class ShelfManager extends BaseScriptComponent {
  @ui.label("Shelf — persistence, naming, critique")
  @ui.separator
  @input kiln: KilnStation;
  @input mesher: LatheMesher;
  @input @hint("GlazeMat, so a reloaded piece gets its glaze back.") glazeMaterial: Material;
  @input @hint("Studio UI. Optional - the shelf still persists without a panel to draw it on.")
  ui: WheelStudioUI;

  @ui.group_start("Naming")
  @input
  @hint("Gemini model id. Known-good through RSG: gemini-2.0-flash, gemini-2.5-flash, gemini-2.5-pro.")
  geminiModel: string = "gemini-2.5-flash";

  @input
  @hint("Hard timeout in seconds. On expiry the piece keeps its local name and the critique is hidden.")
  @widget(new SliderWidget(5, 60, 1))
  timeoutSeconds: number = 20;
  @ui.group_end

  private shelf: ShelfPiece[] = [];
  private pendingTimedOut = false;
  private naming = false;

  private _onShelfChanged = new Event<ShelfPiece[]>();
  /** Fires whenever the shelf contents change, for the panel to re-render. */
  get onShelfChanged(): PublicApi<ShelfPiece[]> { return this._onShelfChanged.publicApi(); }

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
  }

  private onStart(): void {
    // Subscribe before the first load so the initial contents reach the panel
    // through the same path every later change takes.
    if (this.ui) {
      this._onShelfChanged.publicApi().add(() => this.ui.setShelfPieces(this.getRecent()));
      this.ui.onShelfPick.add((index: number) => {
        const recent = this.getRecent();
        if (index >= 0 && index < recent.length) this.reload(recent[index]);
      });
    } else {
      print("[Shelf] no UI assigned - pieces persist but nothing draws them.");
    }

    this.shelf = this.load();
    print("[Shelf] loaded " + this.shelf.length + " piece(s) from storage");
    this._onShelfChanged.invoke(this.shelf);

    if (this.kiln) {
      this.kiln.onFired.add((result: FiringResult) => this.onFired(result));
    } else {
      print("[Shelf] kiln not assigned - pieces will never be added.");
    }
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  private load(): ShelfPiece[] {
    try {
      const store = global.persistentStorageSystem.store;
      if (!store.has(STORAGE_KEY)) return [];
      return deserializeShelf(store.getString(STORAGE_KEY));
    } catch (e) {
      // A read failure must not stop the studio opening; start with an empty shelf.
      print("[Shelf] load failed, starting empty: " + e);
      this.say("Couldn't read the shelf — starting empty.");
      return [];
    }
  }

  private save(): void {
    try {
      global.persistentStorageSystem.store.putString(STORAGE_KEY, serializeShelf(this.shelf));
    } catch (e) {
      print("[Shelf] save failed: " + e);
      this.say("Couldn't save that piece.");
    }
  }

  /** One short sentence under the shelf. Never the exception text. */
  private say(message: string): void {
    if (this.ui) this.ui.setShelfNote(message);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  getShelf(): ShelfPiece[] { return this.shelf; }
  getRecent(): ShelfPiece[] { return recentPieces(this.shelf); }

  /**
   * Put a stored piece back on the wheel. It returns FIRED and read-only: the
   * profile and glaze are restored, and the piece cannot be reshaped, because
   * it already went through the kiln once.
   */
  reload(piece: ShelfPiece): boolean {
    if (!piece || !this.mesher) return false;
    const model = this.mesher.getModel();
    model.deserialize(piece.profileBytes);

    if (this.glazeMaterial) {
      applyGlazeToPass(this.glazeMaterial.mainPass, piece.glazeParams, 0);
    }
    print("[Shelf] reloaded \"" + piece.name + "\" (seed " + piece.seed + ")");
    return true;
  }

  // ── Firing -> shelf ───────────────────────────────────────────────────────

  private onFired(result: FiringResult): void {
    // Save FIRST with a local name. The model call can only improve the entry;
    // it can never be the reason a finished piece fails to reach the shelf.
    const piece: ShelfPiece = {
      profileBytes: this.mesher.getModel().serialize(),
      glazeParams: result.params,
      seed: result.seed,
      name: localName(result.seed),
      createdAt: Date.now(),
      note: ""
    };
    this.shelf = addPiece(this.shelf, piece);
    this.save();
    this._onShelfChanged.invoke(this.shelf);
    print("[Shelf] saved \"" + piece.name + "\" (" + this.shelf.length + " on shelf)");

    this.requestName(piece, result);
  }

  private requestName(piece: ShelfPiece, result: FiringResult): void {
    if (this.naming) return;
    this.naming = true;
    this.pendingTimedOut = false;

    const timer = this.createEvent("DelayedCallbackEvent");
    timer.bind(() => {
      if (!this.naming) return;
      this.pendingTimedOut = true;
      this.naming = false;
      print("[Shelf] naming TIMEOUT after " + this.timeoutSeconds + "s - keeping local name \"" +
            piece.name + "\", critique hidden");
    });
    timer.reset(this.timeoutSeconds);

    // Describe the form in words the model can reason about, rather than
    // shipping 48 raw samples it would have to interpret.
    const prompt = this.describeForm(result);

    Gemini.models({
      model: this.geminiModel,
      type: "generateContent",
      body: {
        contents: [{parts: [{text: prompt}], role: "user"}],
        systemInstruction: {parts: [{text: NAME_SYSTEM_INSTRUCTION}]},
        generationConfig: {responseMimeType: "application/json", temperature: 0.8}
      }
    })
      .then((response) => {
        if (this.pendingTimedOut) return;
        this.naming = false;
        const raw = this.extractText(response);
        print("[Shelf] RAW NAME RESPONSE: " + raw);
        const parsed = parseNameReply(raw);
        if (parsed === null) {
          print("[Shelf] name reply unparseable - keeping local name, critique hidden");
          return;
        }
        this.applyName(piece.seed, parsed.name, parsed.note);
      })
      .catch((err) => {
        if (this.pendingTimedOut) return;
        this.naming = false;
        print("[Shelf] naming request failed: " + err + " - keeping local name");
      });
  }

  /** Update the stored entry in place, matched by its seed. */
  private applyName(seed: number, name: string, note: string): void {
    for (let i = 0; i < this.shelf.length; i++) {
      if (this.shelf[i].seed === seed) {
        this.shelf[i].name = name;
        this.shelf[i].note = note;
        this.save();
        this._onShelfChanged.invoke(this.shelf);
        print("[Shelf] named \"" + name + "\" - " + note);
        return;
      }
    }
  }

  /** A compact verbal description of the silhouette for the critique prompt. */
  private describeForm(result: FiringResult): string {
    const samples = this.mesher.getModel().getSamples();
    const at = (t: number) => samples[Math.floor(t * (samples.length - 1))].r;
    const foot = at(0.02), belly = at(0.3), waist = at(0.65), rim = at(0.98);
    let widest = 0, widestAt = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].r > widest) { widest = samples[i].r; widestAt = samples[i].y; }
    }
    return "A thrown pot, " + this.mesher.height.toFixed(0) + "cm tall. " +
      "Radii as a fraction of the widest point: foot " + (foot / widest).toFixed(2) +
      ", belly " + (belly / widest).toFixed(2) +
      ", waist " + (waist / widest).toFixed(2) +
      ", rim " + (rim / widest).toFixed(2) + ". " +
      "The widest point sits at " + (widestAt * 100).toFixed(0) + "% of the height. " +
      "Name it and give one honest sentence about its proportions.";
  }

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
}
