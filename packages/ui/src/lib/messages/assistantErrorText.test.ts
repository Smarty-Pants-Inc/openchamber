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
  // No UTC time in the words: the reset is added once, in local time.
  expect(describeAssistantError({ name: 'SmartyLimitError', data: { message: 'Your 5-hour limit is used up.', resetsAt: '2026-09-28T10:30:00Z' } }, local))
    .toBe('Your 5-hour limit is used up. It resets at local(2026-09-28T10:30:00Z).');
  // No usable reset: the words alone.
  expect(describeAssistantError({ name: 'SmartyLimitError', data: { message: 'Your 5-hour limit is used up.', resetsAt: 'soon' } }, local)).toBe('Your 5-hour limit is used up.');
  // Other errors are unchanged.
  expect(describeAssistantError({ name: 'APIError', data: { message: '503: overloaded' } }, local)).toBe('Failed to send the message: 503: overloaded');
});

