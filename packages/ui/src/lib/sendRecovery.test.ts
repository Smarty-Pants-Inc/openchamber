import { expect, test } from 'bun:test';
import { SendRecovery, type RecoveryNotice } from './sendRecovery';

// smarty-code#827 (openchamber#375 reviews 2 and 3): each submission's recovery is its own, keyed by target and content;
// its client ID is fixed at its first Send; its input comes back only into its own target's composer.
function harness() {
  let now = 0; const due: { at: number; fn: () => void; id: number }[] = []; let next = 1, ids = 0;
  const timers = { set: (fn: () => void, ms: number) => { const id = next++; due.push({ at: now + ms, fn, id }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear: (t: ReturnType<typeof setTimeout>) => { const i = due.findIndex(d => d.id === (t as unknown as number)); if (i >= 0) due.splice(i, 1); } };
  const advance = (ms: number) => { now += ms; for (let d; (d = due.filter(x => x.at <= now).sort((a, b) => a.at - b.at)[0]); ) { due.splice(due.indexOf(d), 1); d.fn(); } };
  const r = new SendRecovery(() => 15_000, () => `msg_${++ids}`, timers);
  const log: string[] = [];
  let shown = 's1';
  const hooks = (name: string, target = 's1') => ({ restore: () => { if (shown !== target) return false; log.push(`restore ${name}`); return true; },
    clearIfUntouched: () => { log.push(`clear ${name}`); }, notify: (k: RecoveryNotice) => { log.push(`${k} ${name}`); } });
  return { r, log, advance, hooks, show: (t: string) => { shown = t; r.flush(t); } };
}
const A = SendRecovery.signature('text A'), B = SendRecovery.signature('text B');

test('an unanswered send gives its input back after 15 s; a late acceptance clears that copy', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!;
  advance(14_999); expect(log).toEqual([]);
  advance(1); expect(log).toEqual(['restore A', 'unconfirmed A']);
  a.accepted(); expect(log).toEqual(['restore A', 'unconfirmed A', 'clear A', 'delivered-late A']);
});

test('the client ID is fixed at the first Send: a re-send before any ID callback (a stalled preparation) uses the same one', () => {
  const { r, advance, hooks } = harness();
  const first = r.begin('s1', A, hooks('A'))!; // Its preparation (e.g. snippet expansion) stalls: no POST yet.
  advance(15_000); // Given back.
  const again = r.begin('s1', A, hooks('A again'))!;
  expect(again.messageID).toBe(first.messageID);
});

for (const timing of ['before', 'after', 'due'] as const) test(`verified target transfer ${timing} watchdog keeps client ID, pending attempts and late-copy cleanup`, () => {
  const { r, log, advance, hooks, show } = harness();
  let target = 's1';
  const currentHooks = () => ({
    restore: () => hooks('moved', target).restore(),
    retarget: () => { target = 's2'; },
    clearIfUntouched: () => { log.push(`clear ${target}`); },
    notify: hooks('moved').notify,
  });
  const first = r.begin('s1', A, currentHooks())!;
  if (timing === 'due') show('unrelated');
  if (timing !== 'before') advance(15_000);
  r.transferTarget('s1', 's2'); show('s2');
  if (timing === 'before') advance(15_000);
  expect(log.filter(entry => entry.startsWith('restore'))).toHaveLength(1);
  const retry = r.begin('s2', A, currentHooks())!;
  expect(retry.messageID).toBe(first.messageID);
  expect(r.wouldBlock('s2', A)).toBe(true);
  retry.conflict(); advance(15_000);
  first.accepted(); expect(log).toContain('clear s2');
  advance(60_000); expect(log.filter(entry => entry.startsWith('restore'))).toHaveLength(2);
});

test('a transfer never rebinds another target\'s recovery or grants automatic resend', () => {
  const { r, log, advance, hooks } = harness();
  r.begin('s1', A, hooks('A'))!;
  const other = r.begin('s3', A, hooks('other', 's3'))!;
  r.transferTarget('s1', 's2');
  expect(r.wouldBlock('s2', A)).toBe(true);
  expect(r.wouldBlock('s3', A)).toBe(true);
  expect(log).toEqual([]);
  other.accepted(); advance(15_000);
  expect(log).not.toContain('restore other');
});

test('two overlapping sends: B succeeding never disarms A\'s recovery', () => {
  const { r, log, advance, hooks } = harness();
  r.begin('s1', A, hooks('A'))!;
  advance(5_000);
  r.begin('s1', B, hooks('B'))!.accepted();
  advance(10_000); expect(log).toEqual(['restore A', 'unconfirmed A']);
});

test('the same text to another session is its own submission: not blocked, and its own ID', () => {
  const { r, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!;
  const other = r.begin('s2', A, hooks('A in s2', 's2'));
  expect(other).not.toBeNull(); expect(other!.messageID).not.toBe(a.messageID);
});

test('the same content re-sent while its send is unanswered (input not given back) is refused, not posted twice', () => {
  const { r, log, hooks } = harness();
  r.begin('s1', A, hooks('A'))!;
  expect(r.begin('s1', A, hooks('A2'))).toBeNull();
  expect(log).toEqual(['still-pending A']);
});

test('edited content or other attachments are a new message (a new ID)', () => {
  const { r, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; advance(15_000);
  expect(r.begin('s1', SendRecovery.signature('text A', ['file-1']), hooks('A+file'))!.messageID).not.toBe(a.messageID);
  expect(r.begin('s1', SendRecovery.signature('text A, edited'), hooks('edited'))!.messageID).not.toBe(a.messageID);
});

test('retry conflict, then the original is refused: the input comes back (neither was delivered)', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!;
  advance(15_000);
  const retry = r.begin('s1', A, hooks('retry'))!;
  retry.conflict(); a.refused();
  expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A', 'restore retry']);
});

test('retry conflict, then no answer: the input comes back again after 15 s; a late acceptance clears it', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!;
  advance(15_000);
  r.begin('s1', A, hooks('retry'))!.conflict();
  advance(15_000); expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A', 'restore retry']);
  a.accepted(); expect(log.at(-2)).toBe('clear retry');
});

test('shown elsewhere when due: nothing is written; it comes back when its session is shown again', () => {
  const { r, log, advance, hooks, show } = harness();
  r.begin('s1', A, hooks('A'))!;
  show('s2'); advance(15_000);
  expect(log).toEqual([]); // Never into another session's composer or s1's saved draft.
  show('s1');
  expect(log).toEqual(['restore A', 'unconfirmed A']);
});

test('two unanswered sends due while their session was not shown both come back, in order', () => {
  const { r, log, advance, hooks, show } = harness();
  r.begin('s1', A, hooks('A'))!; r.begin('s1', B, hooks('B'))!;
  show('s2'); advance(15_000); show('s1');
  expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A', 'restore B']);
});

test('due while not shown, then accepted: nothing comes back later', () => {
  const { r, log, advance, hooks, show } = harness();
  const a = r.begin('s1', A, hooks('A'))!;
  show('s2'); advance(15_000); a.accepted(); show('s1');
  expect(log).toEqual([]);
});

test('due off-screen: saved once into its target draft, holds reloads while due, and a late acceptance clears the saved copy', () => {
  const { r, log, advance, hooks, show } = harness();
  show('s2');
  const saving = (name: string) => ({ ...hooks(name), save: () => { log.push(`save ${name}`); } });
  const a = r.begin('s1', A, saving('A'))!;
  advance(15_000); expect(log).toEqual(['save A']); expect(r.hasDue()).toBe(true);
  advance(60_000); expect(log).toEqual(['save A']); // Saved once only.
  a.accepted(); expect(log).toEqual(['save A', 'clear A', 'delivered-late A']); expect(r.hasDue()).toBe(false);
  log.length = 0;
  r.begin('s1', B, saving('B'))!.refused(); expect(log).toEqual(['save B']); expect(r.hasDue()).toBe(true);
  show('s1'); expect(log).toEqual(['save B', 'restore B']); expect(r.hasDue()).toBe(false);
});
