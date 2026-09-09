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
