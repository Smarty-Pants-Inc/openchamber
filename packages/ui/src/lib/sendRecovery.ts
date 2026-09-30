/**
 * smarty-code#827: a send to a Pi session never loses its text, and is never posted twice.
 *
 * One GROUP per submission: its target (runtime, directory, session) and its content (text, attachments, context). A
 * group has ONE client message ID, fixed when it begins (before any preparation that may stall): every attempt sends
 * with it, so the gateway's client-ID reservation dedupes a re-send of the restored, unedited content (openchamber#375
 * review 3, P1 2). The composer clears at Send; the group's input comes back when no attempt is answered within `ms`,
 * when every attempt is refused, or after a reservation conflict not followed by an acceptance within `ms`. A conflict
 * is never acceptance. An acceptance clears a restored copy that is still untouched.
 *
 * Restoring goes only into the composer while it shows the group's own target (review 3, P1 1): otherwise the group is
 * DUE and comes back when that target is shown again (flush), after that target's own newer draft, never over it, and
 * its attachments and context never reach another target's composer. Each group, its timers and its settlement touch
 * only that group.
 */
/** The gateway's client-ID reservation conflict: another attempt with this ID is pending or was delivered. Not a refusal
 * of the message itself (openchamber#375 review 4): its row, its chat and the session view stay. */
export const isClientIdConflict = (message: string | null | undefined) =>
  !!message && /client message id already exists or a submission is pending/i.test(message);
export type RecoveryNotice = 'unconfirmed' | 'delivered-late' | 'still-pending';
type Hooks = {
  /** Brings the input back into the composer; false when the composer does not show this group's target now. */
  restore: () => boolean;
  /** Saves the text into its target's saved draft (joined, never over it) while the target is not shown, so a reload or
   * an unmount cannot lose it (openchamber#375 review 5); after that, `restore` brings back only what is not text. */
  save?: () => void;
  clearIfUntouched: () => void;
  notify: (kind: RecoveryNotice) => void;
};
type Group = Hooks & { key: string; target: string; messageID: string; pending: number; delivered: boolean; copyInComposer: boolean; saved: boolean;
  due: RecoveryNotice | null; timers: Set<ReturnType<typeof setTimeout>> };
export type RecoveryAttempt = {
  /** The client message ID this attempt must send with (the group's, fixed at its first Send). */
  messageID: string;
  accepted(): void;
  /** A client-ID reservation conflict: another attempt of this group holds (or held) the ID. Not acceptance. Returns
   * true when an earlier attempt of this group was already accepted: there is nothing to say (smarty-code#962). */
  conflict(): boolean;
  /** A definite refusal of this attempt. */
  refused(): void;
};
type Timers = { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void };

export class SendRecovery {
  private groups = new Map<string, Group>();
  constructor(private ms: () => number, private newID: () => string,
    private timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t) }) {}

  /** The content signature: text plus the identity of every attached file and context part. */
  static signature(text: string, attachments: readonly string[] = []) { return JSON.stringify([text, [...attachments].sort()]); }

  /** True when a Send of `content` to `target` would post it twice (its send is unanswered and its text not given back). */
  wouldBlock(target: string, content: string) {
    const g = this.groups.get(`${target}\u0000${content}`);
    return !!g && !g.delivered && g.pending > 0 && !g.copyInComposer;
  }

  /**
   * A Send of `content` to `target`. Returns null when the same content's send to the same target is still unanswered
   * and its input was not given back (a second Send would post it twice): the caller keeps the input and says so.
   */
  begin(target: string, content: string, hooks: Hooks): RecoveryAttempt | null {
    const key = `${target}\u0000${content}`;
    let g = this.groups.get(key);
    if (g && !g.delivered && g.pending > 0 && !g.copyInComposer) { g.notify('still-pending'); return null; }
    if (g && !g.delivered && g.copyInComposer) {
      // The restored copy goes again: the same message, the same ID. The copy leaves the composer (it clears at Send).
      g.copyInComposer = false; g.saved = false; g.due = null; Object.assign(g, hooks);
    } else {
      if (g) this.drop(g);
      g = { key, target, ...hooks, messageID: this.newID(), pending: 0, delivered: false, copyInComposer: false, saved: false, due: null, timers: new Set() };
      this.groups.set(key, g);
    }
    const group = g; let settled = false;
    group.pending += 1;
    const timer = this.arm(group);
    const settle = () => { if (settled) return false; settled = true; group.pending -= 1; this.timers.clear(timer); group.timers.delete(timer); return true; };
    return {
      messageID: group.messageID,
      accepted: () => {
        if (!settle()) return;
        group.delivered = true; group.due = null;
        if (group.copyInComposer || group.saved) { group.copyInComposer = group.saved = false; group.clearIfUntouched(); group.notify('delivered-late'); }
        this.drop(group);
      },
      conflict: () => { if (settle() && !group.delivered) this.arm(group); return group.delivered; },
      refused: () => {
        if (!settle() || group.delivered || group.copyInComposer || group.pending > 0) return;
        this.giveBack(group, null);
      },
    };
  }

  /** The composer shows `target` again: every group due there comes back now, in the order it became due. */
  flush(target: string) {
    for (const g of [...this.groups.values()]) if (g.target === target && g.due && !g.delivered && !g.copyInComposer) this.giveBack(g, g.due === 'still-pending' ? null : g.due);
  }

  /** Whether any group's input is due (not back yet): a reload waits (lib/newBuildReload). */
  hasDue() { return [...this.groups.values()].some(g => g.due && !g.delivered && !g.copyInComposer); }

  /** Brings a group's input back now, or marks it due for when its target is shown. */
  private giveBack(g: Group, notice: RecoveryNotice | null) {
    if (g.restore()) { g.copyInComposer = true; g.due = null; if (notice) g.notify(notice); }
    else {
      g.due = notice ?? 'still-pending'; // 'still-pending' here only marks "due, no notice".
      if (!g.saved && g.save) { g.save(); g.saved = true; }
    }
  }

  /** A watchdog for this group: if nothing is delivered and its input is not back when it fires, it comes back. */
  private arm(g: Group) {
    const t = this.timers.set(() => {
      g.timers.delete(t);
      if (g.delivered || g.copyInComposer || g.due) return;
      this.giveBack(g, 'unconfirmed');
    }, this.ms());
    g.timers.add(t);
    return t;
  }

  /** Forget a group. */
  private drop(g: Group) {
    for (const t of g.timers) this.timers.clear(t);
    g.timers.clear();
    if (this.groups.get(g.key) === g) this.groups.delete(g.key);
  }
}
