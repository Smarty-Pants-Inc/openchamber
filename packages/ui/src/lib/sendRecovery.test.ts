import { expect, test } from 'bun:test';
import { SendRecovery, type RecoveryNotice } from './sendRecovery';

// smarty-code#827 (openchamber#375 review round 2): each submission's recovery is its own, keyed by target and content.
function harness() {
  let now = 0; const due: { at: number; fn: () => void; id: number }[] = []; let next = 1;
  const timers = { set: (fn: () => void, ms: number) => { const id = next++; due.push({ at: now + ms, fn, id }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear: (t: ReturnType<typeof setTimeout>) => { const i = due.findIndex(d => d.id === (t as unknown as number)); if (i >= 0) due.splice(i, 1); } };
  const advance = (ms: number) => { now += ms; for (let d; (d = due.filter(x => x.at <= now).sort((a, b) => a.at - b.at)[0]); ) { due.splice(due.indexOf(d), 1); d.fn(); } };
  const r = new SendRecovery(() => 15_000, timers);
  const log: string[] = [];
  const hooks = (name: string) => ({ restore: () => log.push(`restore ${name}`), clearIfUntouched: () => log.push(`clear ${name}`),
    notify: (k: RecoveryNotice) => log.push(`${k} ${name}`) });
  return { r, log, advance, hooks };
}
const A = SendRecovery.signature('text A'), B = SendRecovery.signature('text B');

test('an unanswered send gives its text back after 15 s; a late acceptance clears that copy', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; a.setMessageID('m1');
  advance(14_999); expect(log).toEqual([]);
  advance(1); expect(log).toEqual(['restore A', 'unconfirmed A']);
  a.accepted(); expect(log).toEqual(['restore A', 'unconfirmed A', 'clear A', 'delivered-late A']);
});

test('two overlapping sends: B succeeding never disarms A\'s recovery', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; a.setMessageID('mA');
  advance(5_000);
  const b = r.begin('s1', B, hooks('B'))!; b.setMessageID('mB'); b.accepted();
  advance(10_000); expect(log).toEqual(['restore A', 'unconfirmed A']);
});

test('the same text to another session is its own submission: not blocked, and never takes the first one\'s ID', () => {
  const { r, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; a.setMessageID('m1');
  const other = r.begin('s2', A, hooks('A in s2'));
  expect(other).not.toBeNull(); expect(other!.reuseID).toBeUndefined();
  advance(15_000);
  const again = r.begin('s2', A, hooks('A in s2 again'));
  expect(again?.reuseID).toBeUndefined();
});

test('the same content re-sent while its send is unanswered (text not given back) is refused, not posted twice', () => {
  const { r, log, hooks } = harness();
  r.begin('s1', A, hooks('A'))!.setMessageID('m1');
  expect(r.begin('s1', A, hooks('A2'))).toBeNull();
  expect(log).toEqual(['still-pending A']);
});

test('the restored content re-sent unedited reuses the ID; edited content or other attachments get a new one', () => {
  const { r, advance, hooks } = harness();
  r.begin('s1', A, hooks('A'))!.setMessageID('m1');
  advance(15_000);
  expect(r.begin('s1', A, hooks('A again'))!.reuseID).toBe('m1');
  const x = harness(); x.r.begin('s1', A, x.hooks('A'))!.setMessageID('m1'); x.advance(15_000);
  expect(x.r.begin('s1', SendRecovery.signature('text A', ['file-1']), x.hooks('A+file'))!.reuseID).toBeUndefined();
  expect(x.r.begin('s1', SendRecovery.signature('text A, edited'), x.hooks('edited'))!.reuseID).toBeUndefined();
});

test('retry conflict, then the original is refused: the text comes back (neither was delivered)', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; a.setMessageID('m1');
  advance(15_000); // Back once.
  const retry = r.begin('s1', A, hooks('retry'))!; expect(retry.reuseID).toBe('m1');
  retry.conflict(); // The reservation is taken by the original: not acceptance.
  a.refused();
  expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A', 'restore retry']);
});

test('retry conflict, then no answer at all: the text comes back again after 15 s', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; a.setMessageID('m1');
  advance(15_000);
  r.begin('s1', A, hooks('retry'))!.conflict();
  advance(14_999); expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A']);
  advance(1); expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A', 'restore retry']);
  a.accepted(); expect(log.at(-2)).toBe('clear retry'); // Delivered after all: the untouched copy goes.
});

test('retry conflict, then the original is accepted: delivered once, nothing comes back', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; a.setMessageID('m1');
  advance(15_000);
  r.begin('s1', A, hooks('retry'))!.conflict();
  a.accepted(); advance(60_000);
  expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A']);
});

test('a refusal with the text already back does not bring it back twice', () => {
  const { r, log, advance, hooks } = harness();
  const a = r.begin('s1', A, hooks('A'))!; advance(15_000); a.refused();
  expect(log.filter(l => l.startsWith('restore'))).toEqual(['restore A']);
});
