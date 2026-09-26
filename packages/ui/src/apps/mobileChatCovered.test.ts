import { expect, test } from 'bun:test';
import { mobileChatCovered } from './mobileChatCovered';

test('a phone full-screen surface covers the chat; a tablet dialog and no surface do not', () => {
  expect(mobileChatCovered(null, 'fullscreen', true)).toBe(false); // In chat.
  expect(mobileChatCovered('settings', 'fullscreen', false)).toBe(true); // Full-screen Settings.
  expect(mobileChatCovered('update', 'fullscreen', false)).toBe(true);
  expect(mobileChatCovered('instances', 'fullscreen', true)).toBe(true);
  expect(mobileChatCovered('instances', 'fullscreen', false)).toBe(false); // Not shown without Capacitor features.
  expect(mobileChatCovered('settings', 'dialog', true)).toBe(false); // A tablet: side by side.
});

test('a phone Plan opened full-screen covers the chat; on a tablet it does not', () => {
  expect(mobileChatCovered(null, 'fullscreen', false, true)).toBe(true);
  expect(mobileChatCovered(null, 'dialog', false, true)).toBe(false);
});
