import { describe, expect, it } from 'vitest';

import {
  assertSettingsPrecondition,
  parseIfMatch,
} from './settings-revision.js';

describe('settings If-Match parsing', () => {
  it('parses quoted commas as part of an entity tag', () => {
    const precondition = parseIfMatch(' "first,second", W/"legacy,tag" ');

    expect(precondition).toEqual({
      any: false,
      etags: ['"first,second"', 'W/"legacy,tag"'],
    });
    expect(() => assertSettingsPrecondition(precondition, '"first,second"')).not.toThrow();
  });

  it('ignores empty elements around real entity tags', () => {
    const precondition = parseIfMatch(', \t"current",, W/"other", ');
    expect(precondition).toEqual({ any: false, etags: ['"current"', 'W/"other"'] });
    expect(() => assertSettingsPrecondition(precondition, '"current"')).not.toThrow();
  });

  it.each(['', ' \t ', ', , '])('treats the present empty list %j as matching nothing', (header) => {
    expect(parseIfMatch(header)).toEqual({ any: false, etags: [] });
    expect(() => assertSettingsPrecondition(parseIfMatch(header), '"current"'))
      .toThrow(expect.objectContaining({ statusCode: 412 }));
  });

  it('still rejects mixed wildcards and excessive lists', () => {
    for (const header of [', *', '*, "tag"', ','.repeat(8193), Array(65).fill('"tag"').join(',')]) {
      expect(() => parseIfMatch(header)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
    expect(parseIfMatch(undefined)).toBeNull();
  });

  it('keeps the wildcard precondition', () => {
    expect(parseIfMatch(' * ')).toEqual({ any: true, etags: [] });
  });

  it('accepts weak entity tags but never strong-matches them', () => {
    const precondition = parseIfMatch('W/"current"');

    expect(() => assertSettingsPrecondition(precondition, '"current"'))
      .toThrow(expect.objectContaining({ statusCode: 412 }));
  });

  it('rejects an unterminated entity tag', () => {
    expect(() => parseIfMatch('"unterminated')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
