import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { readBilling, resetBillingForTests } from '@/lib/billingLinks';
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

test('the server answer is read once; a failure, an error status or a malformed answer reads as no links', async () => {
  let calls = 0;
  const answer = (value: Response | Error) => async () => { calls += 1; if (value instanceof Error) throw value; return value; };
  resetBillingForTests();
  expect(await readBilling(answer(Response.json(owner)))).toEqual(owner);
  expect(await readBilling(answer(Response.json({ owner: false })))).toEqual(owner);
  expect(calls).toBe(1);
  for (const value of [new Error('offline'), new Response('', { status: 401 }), Response.json({ owner: 'yes', checkout: 'javascript:alert(1)' })]) {
    resetBillingForTests();
    expect(await readBilling(answer(value))).toEqual({ owner: false });
  }
});
