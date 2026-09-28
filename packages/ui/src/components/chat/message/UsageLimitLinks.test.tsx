import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { isBillingCurrent, readBilling, resetBillingForTests } from '@/lib/billingLinks';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { BillingLinks } from './UsageLimitLinks';

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

test('the server answer is read once per runtime; a failure, an error status or a malformed answer reads as no links and is not kept', async () => {
  let calls = 0;
  const answer = (value: Response | Error) => async () => { calls += 1; if (value instanceof Error) throw value; return value; };
  resetBillingForTests();
  expect(await readBilling(answer(Response.json(owner)))).toMatchObject(owner);
  expect(await readBilling(answer(Response.json({ owner: false })))).toMatchObject(owner);
  expect(calls).toBe(1);
  for (const value of [new Error('offline'), new Response('', { status: 401 }), Response.json({ owner: 'yes', checkout: 'javascript:alert(1)' })]) {
    resetBillingForTests();
    expect(await readBilling(answer(value))).toMatchObject({ owner: false });
  }
  resetBillingForTests(); calls = 0;
  await readBilling(answer(new Error('offline')));
  expect(await readBilling(answer(Response.json(owner)))).toMatchObject(owner); // the failure was not kept
  expect(calls).toBe(2);
});

test('another runtime reads again: owner then member, member then owner; a read started before a switch is stale', async () => {
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
  let release: (value: Response) => void = () => {};
  const pending = readBilling(() => new Promise<Response>((resolve) => { release = resolve; }));
  switchRuntimeEndpoint({ apiBaseUrl: 'https://node-b.test', runtimeKey: 'billing-b2' });
  release(Response.json(owner));
  expect(isBillingCurrent(await pending)).toBe(false); // a late answer is not current on the new runtime
});
