import { expect, test } from 'bun:test';
import { SendRecovery, type RecoveryNotice } from './sendRecovery';

// smarty-code#827 (openchamber#375 reviews 2 and 3): each submission's recovery is its own, keyed by target and content;
// its client ID is fixed at its first Send; its input comes back only into its own target's composer.
function harness() {
  let now = 0; const due: { at: number; fn: () => void; id: ReturnType<typeof setTimeout> }[] = []; let ids = 0;
  const timers = { set: (fn: () => void, ms: number) => {
    // Use an immediately cancelled native handle as identity; only advance() executes the fixture callback.
    const id = setTimeout(() => {}, 0); clearTimeout(id);
    due.push({ at: now + ms, fn, id }); return id;
  }, clear: (t: ReturnType<typeof setTimeout>) => { const i = due.findIndex(d => d.id === t); if (i >= 0) due.splice(i, 1); } };
  const advance = (ms: number) => { now += ms; for (let d; (d = due.filter(x => x.at <= now).sort((a, b) => a.at - b.at)[0]); ) { due.splice(due.indexOf(d), 1); d.fn(); } };
  const r = new SendRecovery(() => 15_000, () => `msg_${++ids}`, timers);
  const log: string[] = [];
  let shown = 's1';
  const hooks = (name: string, target = 's1') => ({ restore: () => { if (shown !== target) return false; log.push(`restore ${name}`); return true; },
    clearIfUntouched: () => { log.push(`clear ${name}`); }, notify: (k: RecoveryNotice) => { log.push(`${k} ${name}`); } });
  return { r, log, advance, hooks, show: (t: string) => { shown = t; r.flush(t); } };
}
const A = SendRecovery.signature('text A'), B = SendRecovery.signature('text B');

for (const source of ['text block', 'attachment', 'synthetic part'] as const) {
  test(`captured owned ${source} blocks a new-ID mixed singleton, not unrelated input or exact retry`, () => {
    const h = harness(), copy = Symbol(source);
    const hooks = { ...h.hooks(source), ownsCandidate: (candidate: { ownedCopies: readonly symbol[] }) => candidate.ownedCopies.includes(copy) };
    const original = h.r.begin('s1', A, hooks)!;
    h.advance(15_000);
    const mixed = { content: B, ownedCopies: [copy] };
    expect(h.r.wouldBlockOwned('s1', mixed)).toBe(true);
    expect(h.r.begin('s1', B, h.hooks('mixed'), mixed)).toBeNull();
    expect(h.r.wouldBlockOwned('other', mixed)).toBe(false);
    expect(h.r.wouldBlockOwned('s1', { content: B, ownedCopies: [] })).toBe(false);
    const retry = h.r.begin('s1', A, hooks, { content: A, ownedCopies: [copy] })!;
    expect(retry.messageID).toBe(original.messageID);
    expect(retry.canDispatch()).toBe(true);
    original.refused(); retry.refused();
    expect(h.r.wouldBlockOwned('s1', mixed)).toBe(false);
    expect(h.r.begin('s1', B, h.hooks('new'), mixed)).not.toBeNull();
  });
}

test('a settled collision copy remains owned until the other reservation is known across moves', () => {
  const h = harness(), copy = Symbol('settled copy');
  const first = h.r.begin('s1', A, { ...h.hooks('first'), ownsCandidate: candidate => candidate.ownedCopies.includes(copy) })!;
  const other = h.r.begin('s2', A, h.hooks('other', 's2'))!;
  h.r.transferTarget('s2', 's1'); h.advance(15_000); first.refused();
  const mixed = { content: B, ownedCopies: [copy] };
  expect(h.r.wouldBlockOwned('s1', mixed)).toBe(true);
  other.conflict(); h.r.transferTarget('s1', 's3');
  expect(h.r.wouldBlockOwned('s3', mixed)).toBe(true);
  expect(h.r.begin('s3', B, h.hooks('unsafe', 's3'), mixed)).toBeNull();
});

test('captured unrelated input does not acquire ownership from a later watchdog', () => {
  const h = harness(), copy = Symbol('later restore');
  h.r.begin('s1', A, { ...h.hooks('first'), ownsCandidate: candidate => candidate.ownedCopies.includes(copy) })!;
  const captured = { content: B, ownedCopies: [] };
  h.advance(15_000);
  expect(h.r.wouldBlockOwned('s1', captured)).toBe(false);
  expect(h.r.begin('s1', B, h.hooks('unrelated'), captured)).not.toBeNull();
});

test('dispatch rechecks an exact retry when a collision arrives during preparation', () => {
  const h = harness();
  h.r.begin('s1', A, h.hooks('first'))!; h.advance(15_000);
  const retry = h.r.begin('s1', A, h.hooks('retry'))!;
  expect(retry.canDispatch()).toBe(true);
  const other = h.r.begin('s2', A, h.hooks('other', 's2'))!;
  h.r.transferTarget('s2', 's1');
  expect(retry.canDispatch()).toBe(false);
  other.refused();
  expect(retry.canDispatch()).toBe(true);
});

// Navigation does not transfer recovery. Only the later verified B -> A adoption does.
function offscreenCollision() {
  const h = harness();
  const original = h.r.begin('s1', A, h.hooks('original'))!;
  h.show('s2');
  let target = 's2', destination = 's1';
  const movedHooks = () => ({
    restore: () => h.hooks('moved', target).restore(),
    retarget: () => { target = destination; },
    clearIfUntouched: h.hooks('moved').clearIfUntouched,
    notify: h.hooks('moved').notify,
  });
  const moved = h.r.begin('s2', A, movedHooks())!;
  const move = (next: string, copyRetained = true) => {
    const source = target; destination = next;
    h.r.transferTarget(source, next, copyRetained);
  };
  h.show('unrelated'); move('s1');
  return { ...h, original, moved, movedHooks, move };
}

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

test('an offscreen owner move keeps a destination collision reservation blocking retries', () => {
  const { r, log, advance, hooks, show } = harness();
  const first = r.begin('s1', A, hooks('first', 's1'))!;
  show('unrelated'); advance(15_000);
  show('s1'); expect(log).toContain('restore first'); show('unrelated');
  const destination = r.begin('s2', A, hooks('destination', 's2'))!;
  r.transferTarget('s1', 's2');
  first.accepted();
  expect(r.begin('s2', A, hooks('duplicate', 's2'))).toBeNull();
  expect(destination.messageID).not.toBe(first.messageID);
  destination.refused();
});

test('exact offscreen B -> A adoption preserves the original A reservation after B settles', () => {
  const { r, original, moved, advance, show, hooks } = offscreenCollision();
  expect(moved.messageID).not.toBe(original.messageID);
  moved.accepted();
  advance(15_000); show('s1');
  expect(r.wouldBlock('s1', A)).toBe(true);
  expect(r.begin('s1', A, hooks('unsafe'))).toBeNull();
  original.refused();
});

for (const first of ['original', 'moved'] as const) {
  for (const outcome of ['accepted', 'refused', 'conflict'] as const) {
    test(`collision remains fenced after ${first} ${outcome}, including restored copies and late moves`, () => {
      const h = offscreenCollision();
      h.advance(15_000); h.show('s1');
      h[first][outcome]();
      expect(h.r.wouldBlock('s1', A)).toBe(true);
      expect(h.r.begin('s1', A, h.hooks('unsafe'))).toBeNull();
      h.move('s3', false); h.show('s3');
      expect(h.r.wouldBlock('s3', A)).toBe(true);
      expect(h.r.begin('s3', A, h.hooks('unsafe', 's3'))).toBeNull();
      h.move('s4'); h.advance(60_000); h.show('s4');
      expect(h.r.wouldBlock('s4', A)).toBe(true);
      expect(h.r.begin('s4', A, h.hooks('unsafe', 's4'))).toBeNull();
    });
  }
}

test('a conflicted collision member remains reserved after the other member accepts', () => {
  const h = offscreenCollision();
  h.moved.conflict(); h.original.accepted();
  h.advance(15_000); h.show('s1');
  expect(h.r.wouldBlock('s1', A)).toBe(true);
  expect(h.r.begin('s1', A, h.hooks('unsafe'))).toBeNull();
  h.move('s3'); h.show('s3');
  expect(h.r.wouldBlock('s3', A)).toBe(true);
  expect(h.r.begin('s3', A, h.hooks('unsafe', 's3'))).toBeNull();
  // Duplicate callbacks cannot turn the earlier conflict into a definite refusal or acceptance.
  h.moved.refused(); h.moved.accepted();
  expect(h.r.wouldBlock('s3', A)).toBe(true);
});

for (const finalOutcome of ['accepted', 'refused', 'conflict'] as const) {
  test(`an accepted group remains indexed until its pending same-ID retry ${finalOutcome}`, () => {
    const { r, advance, hooks } = harness();
    const original = r.begin('s1', A, hooks('original'))!;
    advance(15_000);
    const retry = r.begin('s1', A, hooks('retry'))!;
    expect(retry.messageID).toBe(original.messageID);
    original.accepted();
    expect(r.wouldBlock('s1', A)).toBe(true);
    expect(r.begin('s1', A, hooks('unsafe'))).toBeNull();
    r.transferTarget('s1', 's2');
    expect(r.wouldBlock('s2', A)).toBe(true);
    retry[finalOutcome]();
    expect(r.wouldBlock('s2', A)).toBe(false);
    const fresh = r.begin('s2', A, hooks('new', 's2'))!;
    expect(fresh.messageID).not.toBe(original.messageID);
  });
}

test('a settled accepted group with a live retry still participates in a later collision', () => {
  const { r, advance, hooks, show } = harness();
  const original = r.begin('s1', A, hooks('original'))!;
  advance(15_000);
  const retry = r.begin('s1', A, hooks('retry'))!;
  original.accepted();
  const other = r.begin('s2', A, hooks('other', 's2'))!;
  r.transferTarget('s2', 's1'); other.refused(); show('s1');
  expect(r.begin('s1', A, hooks('unsafe'))).toBeNull();
  retry.conflict();
  expect(r.wouldBlock('s1', A)).toBe(false);
});

for (const order of ['original-first', 'moved-first'] as const) {
  test(`all definitely refused collision outcomes allow an explicit same-ID retry, ${order}`, () => {
    const h = offscreenCollision();
    if (order === 'original-first') { h.original.refused(); h.moved.refused(); }
    else { h.moved.refused(); h.original.refused(); }
    h.show('s1');
    expect(h.r.wouldBlock('s1', A)).toBe(false);
    const retry = h.r.begin('s1', A, h.hooks('retry'))!;
    expect([h.original.messageID, h.moved.messageID]).toContain(retry.messageID);
    retry.accepted();
    expect(h.r.begin('s1', A, h.hooks('genuinely new'))!.messageID).not.toBe(retry.messageID);
  });
}

test('three colliding groups keep every reservation through multiple empty-target moves', () => {
  const h = offscreenCollision();
  const third = h.r.begin('s3', A, h.hooks('third', 's3'))!;
  h.move('s3'); h.move('s4'); h.advance(15_000); h.show('s4');
  h.original.accepted(); h.moved.refused();
  expect(h.r.begin('s4', A, h.hooks('unsafe', 's4'))).toBeNull();
  third.conflict();
  h.move('s5'); h.show('s5');
  expect(h.r.wouldBlock('s5', A)).toBe(true);
  expect(h.r.begin('s5', A, h.hooks('unsafe', 's5'))).toBeNull();
  expect(h.r.begin('s5', B, h.hooks('unrelated content', 's5'))).not.toBeNull();
  expect(h.r.begin('other-session', A, h.hooks('unrelated session', 'other-session'))).not.toBeNull();
});

test('legitimate backend refusal fixture admits one native send and no automatic or unsafe collision retry', async () => {
  const h = harness();
  const posted: string[] = [], admitted: string[] = [];
  let owner = 's1';
  const send = (target: string, name: string) => {
    let copyTarget = target;
    const attempt = h.r.begin(target, A, {
      ...h.hooks(name, target),
      restore: () => h.hooks(name, copyTarget).restore(),
      retarget: () => { copyTarget = owner; },
    });
    if (!attempt) return null;
    posted.push(attempt.messageID);
    let answer: (accepted: boolean) => void = () => { throw new Error('Native fixture receipt is not bound'); };
    const receipt = new Promise<boolean>(resolve => { answer = resolve; });
    const settled = receipt.then(accepted => {
      if (accepted) { admitted.push(attempt.messageID); attempt.accepted(); }
      else attempt.refused();
    });
    return { messageID: attempt.messageID, answer, settled };
  };
  const original = send('s1', 'original')!;
  h.show('s2'); const moved = send('s2', 'moved')!;
  expect(moved.messageID).not.toBe(original.messageID);
  h.show('unrelated'); h.r.transferTarget('s2', 's1');
  // Two POSTs already exist. This fixture requires B's definite backend refusal, not dedupe of distinct IDs.
  moved.answer(false); await moved.settled;
  h.advance(15_000); h.show('s1');
  expect(send('s1', 'unsafe')).toBeNull();
  owner = 's3'; h.r.transferTarget('s1', owner); h.show(owner);
  expect(send(owner, 'unsafe')).toBeNull();
  original.answer(true); await original.settled;
  h.advance(60_000); h.show(owner);
  expect(posted).toEqual([original.messageID, moved.messageID]);
  expect(admitted).toEqual([original.messageID]);
  expect(h.r.wouldBlock(owner, A)).toBe(false);
  expect(h.log).toContain('clear original');
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
