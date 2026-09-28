import { expect, test } from 'bun:test';
import { describeAssistantError } from './assistantErrorText';

test('a user Stop reads as Stopped, not a send failure', () => {
  expect(describeAssistantError({ name: 'MessageAbortedError', data: { message: 'Operation aborted' } })).toBe('Stopped');
});

test('other outcomes keep their existing wording', () => {
  expect(describeAssistantError(undefined)).toBeUndefined();
  expect(describeAssistantError({})).toBeUndefined();
  expect(describeAssistantError({ name: 'MessageAbortedError', data: { message: 'aborted' }, message: 'aborted' }))
    .toBe('The running turn stopped before the next message was sent.');
  expect(describeAssistantError({ name: 'SessionRetry', data: { message: 'attempt 2' } })).toBe('Failed to send a message. Retry attempt info: attempt 2');
  expect(describeAssistantError({ name: 'APIError', data: { message: 'Provider overloaded' } })).toBe('Failed to send the message: Provider overloaded');
});

test('a malformed field does not hide the others', () => {
  expect(describeAssistantError({ name: 'APIError', message: null, data: { message: 'x' } })).toBe('Failed to send the message: x');
  expect(describeAssistantError({ name: 'UnknownError', data: 'str', message: 'boom' })).toBe('Failed to send the message: boom');
  expect(describeAssistantError({ name: 42, message: 'boom' })).toBe('Failed to send the message: boom');
  expect(describeAssistantError({ name: 'APIError', data: { message: null } })).toBe('Failed to send the message: APIError');
});

// smarty-net#136 L3: the org's usage limit, as the gateway projects it (SmartyLimitError).
test('a usage limit shows its own plain words with the reset in local time: no status, JSON or "Failed to send"', () => {
  const local = (iso: string) => `local(${iso})`;
  const error = { name: 'SmartyLimitError', data: { message: 'Your 5-hour limit is used up, so Flash models now run one request at a time. Full speed again at 10:30Z.',
    resetsAt: '2026-09-28T10:30:00Z', window: '5h', isRetryable: false } };
  expect(describeAssistantError(error, local)).toBe('Your 5-hour limit is used up, so Flash models now run one request at a time. Full speed again at local(2026-09-28T10:30:00Z).');
  // The period window's far reset carries its date: the date and time together become the local time.
  expect(describeAssistantError({ name: 'SmartyLimitError', data: { message: "Your plan's allowance for this period is used up. More at 2026-10-28 13:37Z, or add credit: https://billing.smartypants.ai/checkout",
    resetsAt: '2026-10-28T13:37:00Z' } }, local))
    .toBe("Your plan's allowance for this period is used up. More at local(2026-10-28T13:37:00Z).");
  // The notice is the same for every member: no credit link in it (the owner's links are shown beside it).
  for (const [words, shown] of [
    ['Your 5-hour limit is used up. Add credit to continue: https://billing.smartypants.ai/checkout', 'Your 5-hour limit is used up.'],
    ['Your 5-hour limit is used up, so Flash models now run one request at a time, 10 seconds apart. Add credit for full speed: https://billing.smartypants.ai/checkout',
      'Your 5-hour limit is used up, so Flash models now run one request at a time, 10 seconds apart.'],
    ['One request to this model can cost up to $2.00, more than your $1.00 limit. Add credit to use it: https://billing.smartypants.ai/checkout',
      'One request to this model can cost up to $2.00, more than your $1.00 limit.'],
  ] as const) expect(describeAssistantError({ name: 'SmartyLimitError', data: { message: words } }, local)).toBe(shown);
  // No UTC time in the words: the reset is added once, in local time.
  expect(describeAssistantError({ name: 'SmartyLimitError', data: { message: 'Your 5-hour limit is used up.', resetsAt: '2026-09-28T10:30:00Z' } }, local))
    .toBe('Your 5-hour limit is used up. It resets at local(2026-09-28T10:30:00Z).');
  // No usable reset: the words alone.
  expect(describeAssistantError({ name: 'SmartyLimitError', data: { message: 'Your 5-hour limit is used up.', resetsAt: 'soon' } }, local)).toBe('Your 5-hour limit is used up.');
  // Other errors are unchanged.
  expect(describeAssistantError({ name: 'APIError', data: { message: '503: overloaded' } }, local)).toBe('Failed to send the message: 503: overloaded');
});

