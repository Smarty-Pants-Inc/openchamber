import { expect, test } from 'bun:test';
import { createDisplayNameChoice, DISPLAY_NAME_KEY, displayNameSchema, readDisplayName, saveDisplayName } from './displayName';
import { displayNameI18n } from '../i18n/messages/display-name.i18n';

function tabStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

test('independent tabs retain distinct names across rereads; a captured submission cannot change', () => {
  const paul = tabStorage(), kate = tabStorage();
  expect(readDisplayName(paul)).toBe(undefined);
  saveDisplayName(paul, 'Paul');
  saveDisplayName(kate, 'Kate');
  const submitted = readDisplayName(paul);
  saveDisplayName(paul, 'Someone else');
  expect(submitted).toBe('Paul');
  expect(readDisplayName(kate)).toBe('Kate');
  expect(readDisplayName(paul)).toBe('Someone else');
  saveDisplayName(paul, '');
  expect(readDisplayName(paul)).toBe(undefined);
  expect(readDisplayName(kate)).toBe('Kate');
});

test('invalid persisted and selected names fail without overwriting a valid choice', () => {
  const storage = tabStorage();
  saveDisplayName(storage, 'Paul');
  for (const name of [' ', ' Paul', 'Paul ', 'Paul\nKate', '<admin>', 'Paul\u202e', 'x'.repeat(65), '李'.repeat(43)]) {
    expect(() => saveDisplayName(storage, name)).toThrow();
    expect(readDisplayName(storage)).toBe('Paul');
    storage.setItem(DISPLAY_NAME_KEY, name);
    expect(() => readDisplayName(storage)).toThrow();
    saveDisplayName(storage, 'Paul');
  }
  for (const name of [null, {}, 42, []]) expect(displayNameSchema.safeParse(name).success).toBe(false);
  for (const name of ['Kate', "O'Neil", '李', 'A'.repeat(64)]) expect(displayNameSchema.safeParse(name).success).toBe(true);
});

test('storage failure is reported, not an apparent successful name change', () => {
  const storage = {
    getItem: () => { throw new Error('Storage unavailable'); },
    setItem: () => { throw new Error('Storage full'); },
    removeItem: () => { throw new Error('Storage unavailable'); },
  };
  expect(() => readDisplayName(storage)).toThrow('Storage unavailable');
  expect(() => saveDisplayName(storage, 'Paul')).toThrow('Storage full');
  expect(() => saveDisplayName(storage, '')).toThrow('Storage unavailable');
});

test('explicit unnamed choice works despite storage getter, read, write or removal failures', () => {
  const denied = () => { throw new Error('Storage denied'); };
  for (const getStorage of [
    denied,
    () => ({ getItem: denied, setItem: denied, removeItem: denied }),
    () => ({ getItem: () => 'Paul', setItem: denied, removeItem: denied }),
  ]) {
    const choice = createDisplayNameChoice(getStorage);
    expect(() => choice.apply('Kate')).toThrow('Storage denied');
    expect(() => choice.apply('')).toThrow('Storage denied');
    expect(choice.unnamedForTab).toBe(false);
    choice.useUnnamedForTab();
    expect(choice.read()).toBe(undefined);
    expect(choice.unnamedForTab).toBe(true);
    expect(() => choice.apply('Kate')).toThrow('Storage denied');
    expect(choice.unnamedForTab).toBe(true);
    expect(choice.read()).toBe(undefined);
  }
});

test('unnamed recovery is deliberate, tab-local and never erases a saved name', () => {
  const storage = tabStorage();
  const choice = createDisplayNameChoice(() => storage);
  choice.apply('Paul');
  const captured = choice.read();
  choice.useUnnamedForTab();
  expect(choice.read()).toBe(undefined);
  expect(captured).toBe('Paul');
  expect(readDisplayName(storage)).toBe('Paul');
  expect(createDisplayNameChoice(() => storage).read()).toBe('Paul'); // Reload has no in-memory override.
  choice.apply('Kate');
  expect(choice.unnamedForTab).toBe(false);
  expect(choice.read()).toBe('Kate');
  storage.setItem(DISPLAY_NAME_KEY, 'invalid\nname');
  expect(() => choice.read()).toThrow(); // Never silently drop an unreadable name.
  expect(choice.unnamedForTab).toBe(false);
});

test('each shipped locale has translated display-name labels', () => {
  const keys = Object.keys(displayNameI18n.en);
  for (const [locale, messages] of Object.entries(displayNameI18n)) {
    expect(Object.keys(messages)).toEqual(keys);
    if (locale !== 'en') expect(messages['chat.displayName.help']).not.toBe(displayNameI18n.en['chat.displayName.help']);
    expect(messages['chat.displayName.active']).toContain('{name}');
  }
});
