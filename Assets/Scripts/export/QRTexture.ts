/**
 * WHEEL - QRTexture
 *
 * Take the pot home. After firing, the Kiln station shows a QR code and the
 * share URL that encodes the whole piece (see ProfileCodec) in the fragment.
 *
 * The design rule here is that the QR is a bonus and the text is the product.
 * A QR can fail for reasons nobody can debug on a headset - a payload that
 * outgrows version 10, a texture the renderer refuses, a material with no
 * mainPass - and none of those are worth losing the pot over. So the URL is
 * printed to the Logger and written to the panel BEFORE any QR work starts,
 * and every part of the QR path is wrapped so a throw degrades to text-only
 * rather than taking the Lens down.
 */

import {generateQR, matrixToAscii, MIN_VERSION} from "./QRCodeGen";

/** Neutral placeholder; the real user is set on the component. */
export const DEFAULT_GITHUB_USER = "your-github-user";

/**
 * The share link. Single source of truth - never retype this shape at a call
 * site, because the '#v1.' prefix is what tells the viewer page which codec
 * version follows, and a mismatch there is a silently broken link.
 */
export const SHARE_URL_TEMPLATE = "https://{user}.github.io/wheel-specs/#v1.{payload}";

/** Quiet zone in modules. Four is the spec minimum; below it, scanners fail. */
export const QUIET_ZONE_MODULES = 4;

/** Aim for this square texture size; the module scale is the integer that fits. */
export const TARGET_TEXTURE_PX = 384;

/** Hard ceiling, so a version-10 symbol cannot balloon the texture. */
export const MAX_TEXTURE_PX = 512;

/** Build the share link. Falls back to the placeholder user rather than "undefined". */
export function buildShareUrl(user: string, payload: string): string {
  const u = typeof user === "string" && user.length > 0 ? user : DEFAULT_GITHUB_USER;
  const p = typeof payload === "string" ? payload : "";
  return SHARE_URL_TEMPLATE.replace("{user}", u).replace("{payload}", p);
}

import {KilnStation} from "../KilnStation";
import {LatheMesher} from "../core/LatheMesher";
import {encode} from "./ProfileCodec";
import type {PieceData} from "./ProfileCodec";
import type {FiringResult} from "../core/FiringSeed";

/**
 * Resolved lazily inside a try/catch, never at module scope. A module-level
 * requireAsset that cannot resolve throws before onAwake runs and takes the
 * whole component with it - which would mean a missing font file breaks the
 * Lens, the one thing this feature must never do. Without a font the URL text
 * still renders; it is the text that matters, not the typeface.
 */
function shareFont(): Font {
  try {
    return requireAsset("../../Fonts/Google Sans Flex.ttf") as Font;
  } catch (e) {
    print("[QR] share font unavailable, using the default: " + e);
    return null;
  }
}

@component
export class QRTexture extends BaseScriptComponent {
  @ui.label("Share QR — shown at the Kiln after firing")
  @ui.separator
  @input
  @hint("GitHub user in https://<user>.github.io/wheel-specs/#v1.<payload>")
  githubUser: string = DEFAULT_GITHUB_USER;

  @ui.group_start("Display")
  @input
  @allowUndefined
  @hint("Image component that shows the QR texture. Wire this OR qrMesh; both is fine.")
  qrImage: Image;

  @input
  @allowUndefined
  @hint("RenderMeshVisual alternative to qrImage, for a quad in world space.")
  qrMesh: RenderMeshVisual;

  @input
  @allowUndefined
  @hint("Text under the QR showing the full URL. This is the fallback that must always work.")
  urlText: Text;

  /**
   * WHY a white plate: the waveguide is additive, so anything drawn black
   * emits no light and reads as transparent on the glasses. A QR is dark
   * modules on a light field - dark-on-nothing gives a scanner nothing to
   * threshold against, and whatever the wearer happens to be standing in
   * front of becomes the background. The plate is an opaque, unlit white
   * surface sitting behind the code: it supplies the light field the light
   * modules and the quiet zone are supposed to be, so the only thing the
   * camera sees varying is the code itself.
   */
  @input
  @allowUndefined
  @hint("Opaque white backing plate behind the QR. The waveguide cannot render dark, so this supplies the light field.")
  backingPlate: SceneObject;
  @ui.group_end

  @ui.group_start("Source")
  @input
  @allowUndefined
  @hint("Fires the export. Without it nothing ever calls showFor().")
  kiln: KilnStation;

  @input
  @allowUndefined
  @hint("Supplies the silhouette and the lathe parameters that get encoded.")
  mesher: LatheMesher;

  @input
  @allowUndefined
  @hint("Anchor for the self-built panel. Left empty, the panel hangs off this SceneObject.")
  panelAnchor: SceneObject;

  @input
  @hint("Unlit material for the QR quad. Needs ENABLE_BASE_TEX ON, or baseTex is a silent no-op and the code never appears.")
  @allowUndefined
  panelMaterial: Material;

  @input
  @hint("Unlit white material for the backing plate. MUST be a different asset with ENABLE_BASE_TEX OFF - a texture-enabled material with no texture bound renders magenta.")
  @allowUndefined
  plateMaterial: Material;
  @ui.group_end

  @ui.group_start("Rendering")
  @input
  @hint("Flip rows when filling the texture. ProceduralTextureProvider fills bottom-up; leave on unless the QR renders mirrored — a mirrored QR never scans.")
  flipVertical: boolean = true;
  @ui.group_end

  private qrTexture: Texture = null;
  private materialsCloned = false;
  private warned: {[key: string]: boolean} = {};

  onAwake(): void {
    // Build a panel only when nothing was wired by hand, so an authored layout
    // always wins over the generated one. This runs BEFORE the input checks
    // below, which would otherwise warn about visuals we are about to create.
    if (!this.qrImage && !this.qrMesh) {
      try {
        this.buildPanel();
      } catch (e) {
        print("[QR] panel build failed, text URL only: " + e);
      }
    }
    if (this.kiln) {
      this.kiln.onFired.add((r: FiringResult) => this.onFired(r));
    } else {
      print("[QR] no kiln assigned - the export will never trigger.");
    }

    // The panel stays dark until there is something to share.
    this.setQrVisible(false);
    if (!this.urlText) {
      this.warnOnce("urlText", "no urlText wired - the share URL will only reach the Logger.");
    }
    if (!this.qrImage && !this.qrMesh) {
      this.warnOnce("visual", "no qrImage or qrMesh wired - text-only sharing.");
    }
    if (!this.backingPlate) {
      this.warnOnce(
        "plate",
        "no backingPlate wired - the QR will be dark-on-transparent on the waveguide and probably unscannable."
      );
    }
  }

  /**
   * Show the share link for a finished piece.
   *
   * Order is deliberate: URL to the Logger, URL to the panel, and only then
   * the QR. Everything after the text is best-effort.
   */
  /**
   * Turn the piece on the wheel plus the firing result into a payload. The
   * SEED is what makes this worth sharing: firing is a pure function of it, so
   * the receiving page can reproduce this exact pot rather than a lookalike.
   */
  private onFired(result: FiringResult): void {
    if (!this.mesher) {
      print("[QR] no mesher assigned - cannot encode the piece.");
      return;
    }
    try {
      const pts = this.mesher.getModel().getPoints();
      const g = result.params;
      const piece: PieceData = {
        points: pts.map((p) => ({y: p.y, r: p.r})),
        // twist is stored in radians on the mesher but normalised in the payload.
        twist01: this.mesher.twist / (Math.PI * 2),
        fluteCount: this.mesher.fluteCount,
        fluteDepth: this.mesher.fluteDepth,
        height: this.mesher.height,
        baseColorBottom: [g.baseColorBottom[0], g.baseColorBottom[1], g.baseColorBottom[2]],
        baseColorTop: [g.baseColorTop[0], g.baseColorTop[1], g.baseColorTop[2]],
        roughness: g.roughness,
        metallic: g.metallic,
        crackleIntensity: g.crackleIntensity,
        dripAmount: g.dripAmount,
        seed: result.seed
      };
      this.showFor(encode(piece));
    } catch (e) {
      // Encoding must never take the kiln down with it.
      print("[QR] encode failed, nothing shared: " + e);
    }
  }

  /**
   * A white plate, a quad for the code, and the URL underneath. Built in code
   * so sharing needs no authored art, and only when the inspector is empty.
   */
  private buildPanel(): void {
    const anchor = this.panelAnchor ? this.panelAnchor : this.sceneObject;
    const root = global.scene.createSceneObject("QRPanel");
    root.setParent(anchor);

    const quad = (name: string, w: number, h: number, z: number, mat: Material): SceneObject => {
      const so = global.scene.createSceneObject(name);
      so.setParent(root);
      so.getTransform().setLocalPosition(new vec3(0, 0, z));
      const b = new MeshBuilder([
        {name: "position", components: 3},
        {name: "normal", components: 3},
        {name: "texture0", components: 2}
      ]);
      b.topology = MeshTopology.Triangles;
      b.indexType = MeshIndexType.UInt16;
      b.appendVerticesInterleaved([
        -w / 2, -h / 2, 0, 0, 0, 1, 0, 0,
         w / 2, -h / 2, 0, 0, 0, 1, 1, 0,
         w / 2,  h / 2, 0, 0, 0, 1, 1, 1,
        -w / 2,  h / 2, 0, 0, 0, 1, 0, 1
      ]);
      b.appendIndices([0, 1, 2, 0, 2, 3]);
      // updateMesh() is what COMMITS the appended data. getMesh() alone hands
      // back an uncommitted mesh that reports empty and draws nothing.
      b.updateMesh();
      const v = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      v.mesh = b.getMesh();
      if (mat) {
        const m = mat.clone();
        (m.mainPass as any).baseColor = new vec4(1, 1, 1, 1);
        v.clearMaterials();
        v.addMaterial(m);
      }
      return so;
    };

    // Plate is deliberately larger than the code so the quiet zone sits on white.
    // Two DIFFERENT materials on purpose. The code quad needs ENABLE_BASE_TEX
    // on so its texture samples; the plate must not have it, because a
    // texture-enabled material with nothing bound renders magenta.
    this.backingPlate = quad("QRPlate", 13, 13, 0,
      this.plateMaterial ? this.plateMaterial : this.panelMaterial);
    const codeObj = quad("QRCode", 11, 11, 0.1, this.panelMaterial);
    this.qrMesh = codeObj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;

    // The URL in text is the fallback that must survive anything going wrong
    // with the code above, so it is a sibling of the plate rather than a child
    // of it - hiding the QR must never hide the text.
    const textObj = global.scene.createSceneObject("QRUrl");
    textObj.setParent(root);
    textObj.getTransform().setLocalPosition(new vec3(0, -8.2, 0.1));
    const t = textObj.createComponent("Component.Text") as Text;
    const f = shareFont();
    if (f) t.font = f;
    t.text = "";
    t.size = 22;
    t.depthTest = true;
    t.textFill.color = new vec4(1, 1, 1, 1);
    t.horizontalAlignment = HorizontalAlignment.Center;
    t.verticalAlignment = VerticalAlignment.Center;
    t.horizontalOverflow = HorizontalOverflow.Wrap;
    t.verticalOverflow = VerticalOverflow.Overflow;
    t.layoutRect = Rect.create(-8, 8, -2.5, 2.5);
    this.urlText = t;
  }

  showFor(payloadBase64Url: string): void {
    const url = buildShareUrl(this.githubUser, payloadBase64Url);

    // Unconditional, first, before anything that can fail.
    print("[QR] share URL: " + url);
    this.setUrlText(url);

    let matrix: boolean[][] = null;
    try {
      matrix = generateQR(url, MIN_VERSION);
    } catch (e) {
      this.setQrVisible(false);
      print("[QR] generation failed, showing the text URL only: " + e);
      return;
    }

    try {
      // Printed before rendering so a placement bug is visible in the Logger
      // even when the texture path is what actually broke.
      print(matrixToAscii(matrix, QUIET_ZONE_MODULES));
    } catch (e) {
      print("[QR] ascii dump failed (harmless): " + e);
    }

    try {
      const texture = this.renderMatrix(matrix);
      if (texture === null) {
        this.setQrVisible(false);
        return;
      }
      this.qrTexture = texture;
      const applied = this.applyTexture(texture);
      this.setQrVisible(applied);
      if (applied) {
        print(
          "[QR] rendered " +
            matrix.length +
            "x" +
            matrix.length +
            " modules into a " +
            texture.getWidth() +
            "px texture."
        );
      }
    } catch (e) {
      this.setQrVisible(false);
      print("[QR] render failed, showing the text URL only: " + e);
    }
  }

  /** Hide the QR panel. The URL text is left alone - it is the fallback. */
  hide(): void {
    this.setQrVisible(false);
  }

  /** The texture from the last successful showFor, or null. */
  getTexture(): Texture {
    return this.qrTexture;
  }

  /**
   * Matrix to RGBA pixels: opaque white field, black modules, quiet zone
   * included. The scale is an integer number of pixels per module - a
   * fractional scale would resample module edges into grey and cost the
   * scanner its threshold.
   */
  private renderMatrix(matrix: boolean[][]): Texture {
    const modules = matrix.length;
    const span = modules + QUIET_ZONE_MODULES * 2;

    let scale = Math.floor(TARGET_TEXTURE_PX / span);
    if (scale < 1) {
      scale = 1;
    }
    while (span * scale > MAX_TEXTURE_PX && scale > 1) {
      scale--;
    }
    const px = span * scale;

    const texture = ProceduralTextureProvider.create(px, px, Colorspace.RGBA);
    const provider = texture.control as ProceduralTextureProvider;
    if (!provider) {
      print("[QR] procedural texture has no provider - text-only.");
      return null;
    }

    const data = new Uint8Array(px * px * 4);
    // Start opaque white: the light modules and the quiet zone in one pass.
    data.fill(255);

    // Column module index per pixel column, computed once instead of per pixel.
    const colModule: number[] = new Array(px);
    for (let x = 0; x < px; x++) {
      colModule[x] = Math.floor(x / scale) - QUIET_ZONE_MODULES;
    }

    for (let row = 0; row < px; row++) {
      // setPixels fills upward from y, so data row 0 is the BOTTOM of the
      // texture. Flip so module row 0 lands at the top; a vertically flipped
      // QR is a mirrored QR, and mirrored QRs do not decode.
      const imageRow = this.flipVertical ? px - 1 - row : row;
      const my = Math.floor(imageRow / scale) - QUIET_ZONE_MODULES;
      if (my < 0 || my >= modules) {
        continue; // quiet zone row, already white
      }
      const line = matrix[my];
      const rowBase = row * px * 4;
      for (let x = 0; x < px; x++) {
        const mx = colModule[x];
        if (mx < 0 || mx >= modules || !line[mx]) {
          continue;
        }
        const i = rowBase + x * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        // alpha stays 255: the dark modules must occlude, not blend away.
      }
    }

    provider.setPixels(0, 0, px, px, data);
    return texture;
  }

  /** Push the texture onto whichever visuals are wired. Returns true if any took it. */
  private applyTexture(texture: Texture): boolean {
    const visuals: MaterialMeshVisual[] = [];
    if (this.qrImage) {
      visuals.push(this.qrImage);
    }
    if (this.qrMesh) {
      visuals.push(this.qrMesh);
    }
    if (visuals.length === 0) {
      this.warnOnce("visual", "no qrImage or qrMesh wired - text-only sharing.");
      return false;
    }

    let applied = false;
    for (let i = 0; i < visuals.length; i++) {
      const v = visuals[i];
      if (!v.mainMaterial) {
        this.warnOnce("mat" + i, "a QR visual has no material - skipping it.");
        continue;
      }
      // Clone once: the panel material is likely shared with other UI, and
      // writing baseTex on the asset would put a QR on all of it.
      if (!this.materialsCloned) {
        v.mainMaterial = v.mainMaterial.clone();
      }
      v.mainPass.baseTex = texture;
      applied = true;
    }
    if (applied) {
      this.materialsCloned = true;
    }
    return applied;
  }

  private setUrlText(url: string): void {
    if (!this.urlText) {
      this.warnOnce("urlText", "no urlText wired - the share URL will only reach the Logger.");
      return;
    }
    try {
      this.urlText.text = url;
      this.urlText.enabled = true;
    } catch (e) {
      print("[QR] could not write the URL text: " + e);
    }
  }

  private setQrVisible(visible: boolean): void {
    if (this.qrImage) {
      this.qrImage.enabled = visible;
    }
    if (this.qrMesh) {
      this.qrMesh.enabled = visible;
    }
    if (this.backingPlate) {
      this.backingPlate.enabled = visible;
    }
  }

  /** One line per distinct problem. A missing input should not spam every frame. */
  private warnOnce(key: string, message: string): void {
    if (this.warned[key]) {
      return;
    }
    this.warned[key] = true;
    print("[QR] " + message);
  }
}
