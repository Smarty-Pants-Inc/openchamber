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
export type RecoveryCandidate = {
  content: string;
  /** Editor-issued identities captured before consumption or asynchronous preparation. */
  ownedCopies: readonly symbol[];
};
type Hooks = {
  /** Brings the input back into the composer; false when the composer does not show this group's target now. */
  restore: () => boolean;
  /** Saves the text into its target's saved draft (joined, never over it) while the target is not shown, so a reload or
   * an unmount cannot lose it (openchamber#375 review 5); after that, `restore` brings back only what is not text. */
  save?: () => void;
  /** Rebind the saved/editor copy only after the caller verifies an identity-preserving owner move. */
  retarget?: (copyRetained: boolean) => void;
  clearIfUntouched: () => void;
  /** Says whether a captured candidate still contains this group's editor-owned copy. */
  ownsCandidate?: (candidate: RecoveryCandidate) => boolean;
  notify: (kind: RecoveryNotice) => void;
};
type Group = Hooks & { key: string; target: string; content: string; messageID: string; pending: number; reservationUnresolved: boolean; delivered: boolean; copyInComposer: boolean; saved: boolean;
  due: RecoveryNotice | null; timers: Set<ReturnType<typeof setTimeout>> };
export type RecoveryAttempt = {
  /** The client message ID this attempt must send with (the group's, fixed at its first Send). */
  messageID: string;
  /** Recheck this admitted attempt after async preparation, including a later owner collision. */
  canDispatch(): boolean;
  accepted(): void;
  /** A client-ID reservation conflict: another attempt of this group holds (or held) the ID. Not acceptance. Returns
   * true when an earlier attempt of this group was already accepted: there is nothing to say (smarty-code#962). */
  conflict(): boolean;
  /** A definite refusal of this attempt. */
  refused(): void;
};
type Timers = { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void };

export class SendRecovery {
  /** A target/content bucket owns every colliding group until all attempts and reservations are accounted for.
   * Keeping settled members during that lifetime makes the collision fence travel with the bucket on later moves. */
  private groups = new Map<string, Group[]>();
  constructor(private ms: () => number, private newID: () => string,
    private timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t) }) {}

  private isReservationUnresolved(group: Group) {
    return group.pending > 0 || group.reservationUnresolved;
  }

  private blockingGroup(groups: Group[]) {
    if (groups.length > 1) return groups.find(group => this.isReservationUnresolved(group));
    return groups.find(group => this.isReservationUnresolved(group) && (group.delivered || !group.copyInComposer));
  }

  /** Acceptance resolves this ID's reservation, not other attempts' outcomes or another colliding ID. */
  private retireDeliveredGroups(group: Group) {
    const groups = this.groups.get(group.key);
    if (!groups || groups.some(candidate => this.isReservationUnresolved(candidate))) return;
    for (const candidate of groups) if (candidate.delivered) this.drop(candidate);
  }

  private removeGroup(group: Group) {
    const groups = this.groups.get(group.key);
    if (!groups) return;
    const remaining = groups.filter(candidate => candidate !== group);
    if (remaining.length) this.groups.set(group.key, remaining);
    else this.groups.delete(group.key);
  }

  /** The content signature: text plus the identity of every attached file and context part. */
  static signature(text: string, attachments: readonly string[] = []) { return JSON.stringify([text, [...attachments].sort()]); }

  /** True when a Send of `content` to `target` would post it twice (its send is unanswered and its text not given back). */
  wouldBlock(target: string, content: string) {
    const key = `${target}\u0000${content}`;
    const groups = this.groups.get(key);
    if (!groups) return false;
    return !!this.blockingGroup(groups);
  }

  /**
   * A changed signature can still contain a recovery's owned editor copy. This
   * is deliberately target-scoped, but it never blocks an exact singleton
   * retry: that path keeps the group's client ID.
   */
  wouldBlockOwned(target: string, candidate: RecoveryCandidate) {
    for (const groups of this.groups.values()) {
      if (!groups.some(group => this.isReservationUnresolved(group))) continue;
      for (const group of groups) {
        if (group.target !== target || group.content === candidate.content) continue;
        if (group.ownsCandidate?.(candidate)) return true;
      }
    }
    return false;
  }

  /**
   * A Send of `content` to `target`. Returns null when the same content's send to the same target is still unanswered
   * and its input was not given back (a second Send would post it twice): the caller keeps the input and says so.
   */
  begin(target: string, content: string, hooks: Hooks, candidate?: RecoveryCandidate): RecoveryAttempt | null {
    if (candidate && this.wouldBlockOwned(target, candidate)) { hooks.notify('still-pending'); return null; }
    const key = `${target}\u0000${content}`;
    let group: Group | undefined;
    const groups = this.groups.get(key);
    if (groups?.length) {
      const blocking = this.blockingGroup(groups);
      if (blocking) { blocking.notify('still-pending'); return null; }
      group = groups.find(candidate => !candidate.delivered && candidate.copyInComposer);
      // Only fully accounted-for groups can be retired here. A restored singleton still retries its own ID.
      for (const candidate of groups) if (candidate !== group) this.drop(candidate);
    }
    if (group && !group.delivered && group.copyInComposer) {
      // The restored copy goes again: the same message, the same ID. The copy leaves the composer (it clears at Send).
      group.copyInComposer = false; group.saved = false; group.due = null; Object.assign(group, hooks);
    } else {
      if (group) this.drop(group);
      group = { key, target, content, ...hooks, messageID: this.newID(), pending: 0, reservationUnresolved: false, delivered: false, copyInComposer: false, saved: false, due: null, timers: new Set() };
      this.groups.set(key, [group]);
    }
    const activeGroup = group; let settled = false;
    activeGroup.pending += 1;
    const timer = this.arm(activeGroup);
    const settle = () => { if (settled) return false; settled = true; activeGroup.pending -= 1; this.timers.clear(timer); activeGroup.timers.delete(timer); return true; };
    return {
      messageID: activeGroup.messageID,
      canDispatch: () => {
        const bucket = this.groups.get(activeGroup.key);
        return !settled && !activeGroup.delivered && !!bucket?.includes(activeGroup)
          && !bucket.some(group => group !== activeGroup && this.isReservationUnresolved(group));
      },
      accepted: () => {
        if (!settle()) return;
        activeGroup.reservationUnresolved = false;
        activeGroup.delivered = true; activeGroup.due = null;
        if (activeGroup.copyInComposer || activeGroup.saved) { activeGroup.copyInComposer = activeGroup.saved = false; activeGroup.clearIfUntouched(); activeGroup.notify('delivered-late'); }
        this.retireDeliveredGroups(activeGroup);
      },
      conflict: () => {
        if (settle()) {
          if (!activeGroup.delivered) { activeGroup.reservationUnresolved = true; this.arm(activeGroup); }
          this.retireDeliveredGroups(activeGroup);
        }
        return activeGroup.delivered;
      },
      refused: () => {
        if (!settle()) return;
        if (!activeGroup.delivered && !activeGroup.copyInComposer && activeGroup.pending === 0) this.giveBack(activeGroup, null);
        this.retireDeliveredGroups(activeGroup);
      },
    };
  }

  /** A verified same-session owner move changes routing, never submission identity or attempt lifetime. */
  transferTarget(source: string, destination: string, copyRetained = true) {
    if (source === destination) return;
    for (const [sourceKey, sourceGroups] of [...this.groups.entries()]) {
      if (!sourceGroups.some(group => group.target === source)) continue;
      const moving = sourceGroups.filter(group => group.target === source);
      const content = sourceKey.slice(source.length);
      const destinationKey = `${destination}${content}`;
      const destinationGroups = this.groups.get(destinationKey) ?? [];
      const remaining = sourceGroups.filter(group => group.target !== source);
      if (remaining.length) this.groups.set(sourceKey, remaining); else this.groups.delete(sourceKey);
      for (const group of moving) {
        group.target = destination;
        group.key = destinationKey;
        group.retarget?.(copyRetained);
        if (!copyRetained) {
          if (group.copyInComposer) group.due = 'still-pending';
          group.copyInComposer = false;
          group.saved = false;
        }
      }
      this.groups.set(destinationKey, [...destinationGroups, ...moving]);
    }
  }

  /** The composer shows `target` again: every group due there comes back now, in the order it became due. */
  flush(target: string) {
    for (const g of [...this.groups.values()].flat()) if (g.target === target && g.due && !g.delivered && !g.copyInComposer) this.giveBack(g, g.due === 'still-pending' ? null : g.due);
  }

  /** Whether any group's input is due (not back yet): a reload waits (lib/newBuildReload). */
  hasDue() { return [...this.groups.values()].flat().some(g => g.due && !g.delivered && !g.copyInComposer); }

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
    this.removeGroup(g);
  }
}
