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
