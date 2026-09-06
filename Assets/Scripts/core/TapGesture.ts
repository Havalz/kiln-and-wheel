/**
 * WHEEL - TapGesture
 *
 * Telling a ping test apart from a placement.
 *
 * Both gestures start with a pinch on the same vessel and both end with a
 * release, so binding either to onTriggerEnd alone makes them indistinguishable
 * - which is exactly how a tap came to play the bell AND drop the pot across
 * the room in the same gesture.
 *
 * The rule: a TAP is short AND still. Anything held longer, or moved further,
 * is a deliberate placement. Both conditions must hold, so neither a slow
 * careful tap nor a fast flick can be misread - a flick travels, and a lingering
 * touch runs out of time.
 *
 * Pure logic, no Lens API, so the thresholds are checkable offline.
 */

/** Longest a tap may last, in seconds. */
export const TAP_MAX_SECONDS = 0.35;
/** Furthest the hand may travel during a tap, in centimetres. */
export const TAP_MAX_TRAVEL_CM = 3.0;

export interface GestureSample {
  /** Seconds the trigger was held. */
  heldSeconds: number;
  /** Distance the interactor moved between press and release, in cm. */
  travelCm: number;
}

/**
 * True when the gesture reads as a quick tap - the inspection gesture, which
 * must never change the piece.
 */
export function isTap(g: GestureSample): boolean {
  if (!isFinite(g.heldSeconds) || !isFinite(g.travelCm)) return false;
  return g.heldSeconds <= TAP_MAX_SECONDS && g.travelCm <= TAP_MAX_TRAVEL_CM;
}

/** The complement, named so call sites read as intent rather than negation. */
export function isPlacementGesture(g: GestureSample): boolean {
  return !isTap(g);
}
