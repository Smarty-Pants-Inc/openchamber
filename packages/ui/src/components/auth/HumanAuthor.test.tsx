import { expect, test } from 'bun:test';
import { HumanAuthor } from './HumanAuthor';
import { trustedHumanAuthor, trustedTerminalAuthor } from './human-author-data';

const author = { version: 1, issuer: 'https://code.example.test', subject: 'opaque-person-1', name: 'Person' };
const info = (value: unknown) => ({ metadata: { smartyCodeHuman: value } });

test('author schema accepts only a complete server contract, not text or legacy names', () => {
  expect(trustedHumanAuthor(info(author))).toEqual(author);
  for (const malformed of [null, {}, '"Person" says (authenticated)', { name: 'Person' },
    { ...author, version: 2 }, { ...author, subject: '' }, { ...author, image: 'javascript:alert(1)' },
    { ...author, name: '<admin>' }, { ...author, email: 'admin@example.test' }]) {
    expect(trustedHumanAuthor(info(malformed))).toBeUndefined();
    expect(HumanAuthor({ info: info(malformed) })).toBeNull();
  }
  expect(trustedHumanAuthor({ metadata: { smartyCodeDisplayName: 'Person' } })).toBeUndefined();
  expect(trustedHumanAuthor({ content: '"Person" says (authenticated)' })).toBeUndefined();
});

test('historical author snapshot is displayed without consulting mutable profile state', () => {
  const recorded = info(author);
  const renamed = { ...author, name: 'Renamed' };
  expect(trustedHumanAuthor(recorded)?.name).toBe('Person');
  expect(trustedHumanAuthor(info(renamed))?.subject).toBe(author.subject);
  expect(HumanAuthor({ info: recorded })).not.toBeNull();
});

test('a message typed in Herdr is labelled with its server-named owner, "(in Herdr)" (MVP 1)', () => {
  const typed = { metadata: { smartyCodeTerminal: { version: 1, name: 'Paul' } } };
  expect(trustedTerminalAuthor(typed)).toEqual({ version: 1, name: 'Paul' });
  const label = HumanAuthor({ info: typed });
  expect(JSON.stringify(label)).toContain('Paul (in Herdr)');
  // No fleet owner name configured: the server omits it, and the label says only where it was typed.
  expect(JSON.stringify(HumanAuthor({ info: { metadata: { smartyCodeTerminal: { version: 1 } } } }))).toContain('In Herdr');
  for (const malformed of [null, {}, { name: 'Paul' }, { version: 2, name: 'Paul' }, { version: 1, name: '<Paul>' },
    { version: 1, name: ' Paul' }, { version: 1, name: '' }, { version: 1, name: 'Paul', subject: 'x' }]) {
    expect(HumanAuthor({ info: { metadata: { smartyCodeTerminal: malformed } } })).toBeNull();
  }
  // A Code sender's own label wins; text is never evidence.
  expect(JSON.stringify(HumanAuthor({ info: { metadata: { ...info(author).metadata, smartyCodeTerminal: { version: 1, name: 'Paul' } } } })))
    .toContain('Person');
  expect(HumanAuthor({ info: { content: 'Paul (in Herdr): hello' } })).toBeNull();
});
