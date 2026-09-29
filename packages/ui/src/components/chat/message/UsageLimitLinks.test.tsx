import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { isBillingCurrent, readBilling, resetBillingForTests } from '@/lib/billingLinks';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { BillingLinks } from './UsageLimitLinks';
import { useBillingLinks } from '@/lib/useBillingLinks';

// smarty-net#136 L3: the usage-limit notice offers "Add credit" and "Manage plan" to the org owner only.
const owner = { owner: true, checkout: 'https://billing.smartypants.ai/checkout', portal: 'https://billing.smartypants.ai/portal' };

test('the org owner sees Add credit and Manage plan', () => {
  const out = renderToStaticMarkup(<BillingLinks links={owner} />);
  expect(out).toContain('href="https://billing.smartypants.ai/checkout"'); expect(out).toContain('Add credit');
  expect(out).toContain('href="https://billing.smartypants.ai/portal"'); expect(out).toContain('Manage plan');
});

test('a member, or an owner answer without both links, sees no billing link', () => {
  expect(renderToStaticMarkup(<BillingLinks links={{ owner: false }} />)).toBe('');
  expect(renderToStaticMarkup(<BillingLinks links={{ owner: true, checkout: owner.checkout }} />)).toBe('');
});

test('a real answer is read once per runtime; a failure (error status, malformed answer, no connection) is marked failed and never kept', async () => {
  let calls = 0;
  const answer = (value: Response | Error) => async () => { calls += 1; if (value instanceof Error) throw value; return value; };
  resetBillingForTests();
  expect(await readBilling(answer(Response.json(owner)))).toMatchObject(owner);
  expect(await readBilling(answer(Response.json({ owner: false })))).toMatchObject(owner);
  expect(calls).toBe(1);
  for (const value of [new Error('offline'), new Response('', { status: 503 }), Response.json({ owner: 'yes', checkout: 'javascript:alert(1)' })]) {
    resetBillingForTests(); calls = 0;
    expect(await readBilling(answer(value))).toMatchObject({ owner: false, failed: true });
    expect(await readBilling(answer(Response.json(owner)))).toMatchObject(owner); // the same scope asks again, and recovers
    expect(calls).toBe(2);
  }
  resetBillingForTests();
  const member = await readBilling(answer(Response.json({ owner: false })));
  expect(member.failed).toBeUndefined(); // "not the owner" is a real answer, kept for its scope
});

test('another runtime reads again: owner then member, member then owner; a read in flight across a switch is stale', async () => {
  resetBillingForTests();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://node-a.test', runtimeKey: 'billing-a' });
  const onA = await readBilling(async () => Response.json(owner));
  expect(onA).toMatchObject(owner); expect(isBillingCurrent(onA)).toBe(true);
  switchRuntimeEndpoint({ apiBaseUrl: 'https://node-b.test', runtimeKey: 'billing-b' });
  expect(isBillingCurrent(onA)).toBe(false); // A's owner answer is not shown on B
  const onB = await readBilling(async () => Response.json({ owner: false }));
  expect(onB).toMatchObject({ owner: false }); expect(isBillingCurrent(onB)).toBe(true);
  switchRuntimeEndpoint({ apiBaseUrl: 'https://node-a.test', runtimeKey: 'billing-a' });
  expect(await readBilling(async () => Response.json(owner))).toMatchObject(owner); // B's "no" does not hide A's links
  resetBillingForTests(); // an empty cache, so this read really goes out
  let started = false, release: (value: Response) => void = () => {};
  const pending = readBilling(() => { started = true; return new Promise<Response>((resolve) => { release = resolve; }); });
  expect(started).toBe(true);
  switchRuntimeEndpoint({ apiBaseUrl: 'https://node-b.test', runtimeKey: 'billing-b2' });
  release(Response.json(owner));
  expect(isBillingCurrent(await pending)).toBe(false); // a late answer is not current on the new runtime
});

test('a mounted notice recovers: a failed first lookup is asked again later and the owner then sees the links', async () => {
  // Each lookup's answer is released by the test (never a wall-clock sleep): the first fails, the retry answers "owner".
  const lookups: ((value: Response) => void)[] = [];
  const read = () => { resetBillingForTests(); return readBilling(() => new Promise<Response>((resolve) => { lookups.push(resolve); })); };
  const Probe = () => { const links = useBillingLinks(true, read, 0); return links ? <BillingLinks links={links} /> : null; };
  /** Lets React, the pending promises and the (0 ms) retry timer run until `done()`: a bounded number of event-loop
   * turns (each a 0 ms timer turn, so the retry timer gets its turn), never a fixed sleep the result could race. */
  const settle = async (done: () => boolean) => {
    for (let turn = 0; turn < 200 && !done(); turn++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(done()).toBe(true);
  };
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const host = document.createElement('div'); // the global document is happy-dom's (defined just above)
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    await settle(() => lookups.length === 1);
    lookups[0]!(Response.json({}, { status: 503 }));
    // The first lookup failed: no links, and the retry is asked; it is still unanswered, so still no links.
    await settle(() => lookups.length === 2);
    expect(host.innerHTML).toBe('');
    lookups[1]!(Response.json(owner));
    await settle(() => host.innerHTML.includes('Add credit'));
    expect(lookups.length).toBe(2);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
