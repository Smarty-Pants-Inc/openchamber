import { expect, test } from 'bun:test';
import { DISPLAY_NAME_KEY, displayNameSchema, readDisplayName, saveDisplayName } from './displayName';
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
  expect(readDisplayName(paul)).toBeUndefined();
  saveDisplayName(paul, 'Paul');
  saveDisplayName(kate, 'Kate');
  const submitted = readDisplayName(paul);
  saveDisplayName(paul, 'Someone else');
  expect(submitted).toBe('Paul');
  expect(readDisplayName(kate)).toBe('Kate');
  expect(readDisplayName(paul)).toBe('Someone else');
  saveDisplayName(paul, '');
  expect(readDisplayName(paul)).toBeUndefined();
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

test('each shipped locale has translated display-name labels', () => {
  const keys = Object.keys(displayNameI18n.en);
  for (const [locale, messages] of Object.entries(displayNameI18n)) {
    expect(Object.keys(messages)).toEqual(keys);
    if (locale !== 'en') expect(messages['chat.displayName.help']).not.toBe(displayNameI18n.en['chat.displayName.help']);
    expect(messages['chat.displayName.active']).toContain('{name}');
  }
});
