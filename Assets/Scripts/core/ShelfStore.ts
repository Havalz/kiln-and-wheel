/**
 * WHEEL - ShelfStore
 *
 * The shelf: finished pieces, persisted between sessions. Pure logic - the
 * serialisation, the cap, and the offline name generator all run without the
 * Lens API, so the storage format can be tested rather than hoped at.
 *
 * A stored piece is everything needed to rebuild it exactly: the silhouette,
 * the glaze, and the firing seed. Because firing is a pure function of the seed
 * (see FiringSeed), a reloaded piece is the SAME pot, not a lookalike.
 */

import type {GlazeParams} from "./GlazePresets";

/** Maximum pieces kept. Oldest is dropped when a thirteenth is added. */
export const SHELF_CAP = 12;
/** How many the shelf panel shows. */
export const SHELF_VISIBLE = 6;

export interface ShelfPiece {
  /** ProfileModel.serialize() output - the silhouette. */
  profileBytes: string;
  glazeParams: GlazeParams;
  /** Firing seed. Reproduces the kiln's transformation exactly. */
  seed: number;
  name: string;
  /** Epoch ms. */
  createdAt: number;
  /** One sentence of critique. Empty when the model call failed. */
  note?: string;
}

function isFiniteNum(v: any): boolean {
  return typeof v === "number" && isFinite(v);
}

function validColor(v: any): boolean {
  return Array.isArray(v) && v.length === 4 && v.every(isFiniteNum);
}

/**
 * Accept a piece only if every field needed to rebuild it is intact. A
 * half-written entry is worse than a missing one: it would load as a pot that
 * is not the pot the user made.
 */
export function isValidPiece(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  if (typeof p.profileBytes !== "string" || p.profileBytes.length === 0) return false;
  if (!isFiniteNum(p.seed)) return false;
  if (typeof p.name !== "string") return false;
  if (!isFiniteNum(p.createdAt)) return false;
  const g = p.glazeParams;
  if (!g || typeof g !== "object") return false;
  if (!validColor(g.baseColorBottom) || !validColor(g.baseColorTop) || !validColor(g.rimTint)) return false;
  const scalars = ["roughness", "metallic", "crackleScale", "crackleIntensity",
                   "dripAmount", "glossBands", "firedGlow"];
  for (let i = 0; i < scalars.length; i++) {
    if (!isFiniteNum(g[scalars[i]])) return false;
  }
  return true;
}

/** Serialise the shelf for PersistentStorageSystem. */
export function serializeShelf(pieces: ShelfPiece[]): string {
  const capped = capShelf(pieces);
  return JSON.stringify(capped);
}

/**
 * Parse a stored shelf. Corrupt JSON yields an empty shelf rather than
 * throwing, and individual bad entries are dropped instead of poisoning the
 * whole list - one bad write should not cost the user every pot they made.
 */
export function deserializeShelf(raw: string): ShelfPiece[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ShelfPiece[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (isValidPiece(parsed[i])) out.push(parsed[i] as ShelfPiece);
  }
  return capShelf(out);
}

/** Newest last; drop from the front once over the cap. */
export function capShelf(pieces: ShelfPiece[]): ShelfPiece[] {
  if (!Array.isArray(pieces)) return [];
  return pieces.length <= SHELF_CAP ? pieces.slice() : pieces.slice(pieces.length - SHELF_CAP);
}

/** Add a piece and re-cap. Returns a new array; does not mutate the input. */
export function addPiece(pieces: ShelfPiece[], piece: ShelfPiece): ShelfPiece[] {
  const next = Array.isArray(pieces) ? pieces.slice() : [];
  if (isValidPiece(piece)) next.push(piece);
  return capShelf(next);
}

/** The most recent N, newest first - the order the shelf panel displays. */
export function recentPieces(pieces: ShelfPiece[], count: number = SHELF_VISIBLE): ShelfPiece[] {
  const capped = capShelf(pieces);
  const n = Math.min(count, capped.length);
  const out: ShelfPiece[] = [];
  for (let i = 0; i < n; i++) out.push(capped[capped.length - 1 - i]);
  return out;
}

// ── Offline name generator ──────────────────────────────────────────────────

const FORM_WORDS = ["Vessel", "Jar", "Bottle", "Bowl", "Urn", "Flask", "Pitcher", "Vase"];
const QUALITY_WORDS = ["Quiet", "Wide", "Tall", "Narrow", "Heavy", "Pale", "Slow", "Still",
                       "Warm", "Plain", "Rough", "Soft"];
const PLACE_WORDS = ["Morning", "Kiln", "Ash", "River", "Field", "Winter", "Harvest",
                     "Dusk", "Stone", "Hearth"];

/**
 * Deterministic fallback name, derived from the seed so a given piece always
 * gets the same name even when the model call fails. Used whenever Gemini
 * times out, errors, or answers with something unparseable.
 */
export function localName(seed: number): string {
  const s = Math.abs(Math.floor(seed)) || 1;
  const q = QUALITY_WORDS[s % QUALITY_WORDS.length];
  const f = FORM_WORDS[(s >> 3) % FORM_WORDS.length];
  const p = PLACE_WORDS[(s >> 7) % PLACE_WORDS.length];
  return q + " " + f + ", " + p;
}

/** System instruction for the naming call. Kept here so it is testable. */
export const NAME_SYSTEM_INSTRUCTION =
  "You are a ceramics critic naming and appraising a thrown pot. " +
  "Reply with ONLY a single JSON object. No markdown, no code fences, no prose " +
  "outside the object. Exactly two keys:\n" +
  '"name": a short evocative name for the piece, at most 4 words.\n' +
  '"note": ONE sentence of honest critique about the form\'s proportions - ' +
  "the relationship between foot, belly, waist and rim. Be specific and candid; " +
  "if the proportions are awkward, say so plainly. Do not praise reflexively.";

/** Extract {name, note} from a model reply. Null when unparseable. */
export function parseNameReply(text: string): {name: string; note: string} {
  if (typeof text !== "string" || text.length === 0) return null;
  let body = text.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  if (body.charAt(0) !== "{") {
    const s = body.indexOf("{");
    const e = body.lastIndexOf("}");
    if (s === -1 || e === -1 || e <= s) return null;
    body = body.substring(s, e + 1);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.name !== "string" || parsed.name.length === 0) return null;
  return {
    name: parsed.name.substring(0, 40),
    note: typeof parsed.note === "string" ? parsed.note.substring(0, 200) : ""
  };
}
