/**
 * WHEEL - ProfileUndoStack
 *
 * Bounded snapshot history for a ProfileModel. Snapshots are opaque strings
 * (ProfileModel.serialize() output), so this class stays free of Lens API and
 * ProfileModel imports and can be exercised in plain Node.
 *
 * Semantics: the stack always holds the CURRENT state on top. A baseline is
 * pushed once at startup, and every handle release pushes the post-edit state.
 * undo() therefore discards the current top and returns the state to restore.
 */

/** Maximum retained snapshots, including the baseline. */
export const UNDO_LIMIT = 10;

export class ProfileUndoStack {
  private snapshots: string[] = [];
  private limit: number;

  constructor(limit: number = UNDO_LIMIT) {
    this.limit = limit > 1 ? Math.floor(limit) : 2;
  }

  /**
   * Record a state. No-ops on empty input or on a state identical to the
   * current top, so a grab that ends without moving anything does not consume
   * an undo slot. Oldest entries are dropped once the limit is exceeded.
   */
  push(snapshot: string): void {
    if (typeof snapshot !== "string" || snapshot.length === 0) {
      return;
    }
    if (this.snapshots.length > 0 && this.snapshots[this.snapshots.length - 1] === snapshot) {
      return;
    }
    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.limit) {
      this.snapshots.shift();
    }
  }

  /**
   * Discard the current state and return the one to restore, or null when only
   * the baseline remains (nothing to undo).
   */
  undo(): string | null {
    if (this.snapshots.length < 2) {
      return null;
    }
    this.snapshots.pop();
    return this.snapshots[this.snapshots.length - 1];
  }

  canUndo(): boolean {
    return this.snapshots.length >= 2;
  }

  /** Current state, or null if nothing has been pushed. */
  peek(): string | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  depth(): number {
    return this.snapshots.length;
  }

  clear(): void {
    this.snapshots.length = 0;
  }
}
