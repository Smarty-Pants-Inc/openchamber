/**
 * smarty-code#827: a send to a Pi session never loses its text, and is never posted twice.
 *
 * One GROUP per submission: its target (runtime, directory, session) and its content (text, attachments, context). A
 * group's attempts share one client message ID (a re-send of the restored, unedited content reuses it, so the gateway's
 * client-ID reservation dedupes). The composer clears at Send; the group's text comes back when no attempt is answered
 * within `ms`, when every attempt is refused, or after a reservation conflict that is then not followed by an
 * acceptance within `ms`. A conflict is never acceptance. An acceptance clears a restored copy that is still untouched.
 * Each group, its timers and its settlement touch only that group.
 */
export type RecoveryNotice = 'unconfirmed' | 'delivered-late' | 'still-pending';
type Hooks = { restore: () => void; clearIfUntouched: () => void; notify: (kind: RecoveryNotice) => void };
type Group = Hooks & { key: string; messageID?: string; pending: number; delivered: boolean; copyInComposer: boolean; timers: Set<ReturnType<typeof setTimeout>> };
export type RecoveryAttempt = {
  /** The client message ID this attempt must use (a re-send of a restored group), if any. */
  reuseID?: string;
  /** The ID the send actually used. */
  setMessageID(id: string): void;
  accepted(): void;
  /** A client-ID reservation conflict: another attempt of this group holds (or held) the ID. Not acceptance. */
  conflict(): void;
  /** A definite refusal of this attempt. */
  refused(): void;
};
type Timers = { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void };

export class SendRecovery {
  private groups = new Map<string, Group>();
  constructor(private ms: () => number, private timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t) }) {}

  /** The content signature: text plus the identity of every attached file and context part. */
  static signature(text: string, attachments: readonly string[] = []) { return JSON.stringify([text, [...attachments].sort()]); }

  /** True when a Send of `content` to `target` would post it twice (its send is unanswered and its text not given back). */
  wouldBlock(target: string, content: string) {
    const g = this.groups.get(`${target}\u0000${content}`);
    return !!g && !g.delivered && g.pending > 0 && !g.copyInComposer;
  }

  /**
   * A Send of `content` to `target`. Returns null when the same content's send to the same target is still unanswered
   * and its text was not given back (a second Send would post it twice): the caller keeps the text and says so.
   */
  begin(target: string, content: string, hooks: Hooks): RecoveryAttempt | null {
    const key = `${target}\u0000${content}`;
    let g = this.groups.get(key);
    if (g && !g.delivered && g.pending > 0 && !g.copyInComposer) { g.notify('still-pending'); return null; }
    let reuseID: string | undefined;
    if (g && !g.delivered && g.copyInComposer) {
      // The restored copy goes again: the same message, the same ID. The copy leaves the composer (it clears at Send).
      g.copyInComposer = false; reuseID = g.messageID; Object.assign(g, hooks);
    } else {
      if (g) this.drop(g);
      g = { key, ...hooks, pending: 0, delivered: false, copyInComposer: false, timers: new Set() };
      this.groups.set(key, g);
    }
    const group = g; let settled = false;
    group.pending += 1;
    const timer = this.arm(group);
    const settle = () => { if (settled) return false; settled = true; group.pending -= 1; this.timers.clear(timer); group.timers.delete(timer); return true; };
    return {
      reuseID,
      setMessageID: id => { group.messageID ??= id; },
      accepted: () => {
        if (!settle()) return;
        group.delivered = true;
        if (group.copyInComposer) { group.copyInComposer = false; group.clearIfUntouched(); group.notify('delivered-late'); }
        this.drop(group);
      },
      conflict: () => { if (settle() && !group.delivered) this.arm(group); },
      refused: () => {
        if (!settle() || group.delivered || group.copyInComposer || group.pending > 0) return;
        group.copyInComposer = true; group.restore(); this.drop(group, false);
      },
    };
  }

  /** A watchdog for this group: if nothing is delivered and its text is not back when it fires, it comes back. */
  private arm(g: Group) {
    const t = this.timers.set(() => {
      g.timers.delete(t);
      if (g.delivered || g.copyInComposer) return;
      g.copyInComposer = true; g.restore(); g.notify('unconfirmed');
    }, this.ms());
    g.timers.add(t);
    return t;
  }

  /** Forget a group (keepCopy: its restored text is the person's now; only a re-send of it links back). */
  private drop(g: Group, forget = true) {
    for (const t of g.timers) this.timers.clear(t);
    g.timers.clear();
    if (forget && this.groups.get(g.key) === g) this.groups.delete(g.key);
  }
}
