import { expect, test } from 'bun:test';
import { HumanAuthor, trustedHumanAuthor } from './HumanAuthor';

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
