import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./MultiRunFusionDialog.tsx', import.meta.url)), 'utf8');

describe('MultiRunFusionDialog dispatch', () => {
  test('uses the client supplied by send preflight for fusion prompts', () => {
    const preflightStart = source.indexOf('await withSessionSendPreflight({');
    const dispatch = source.slice(preflightStart, source.indexOf('\n    } catch', preflightStart));

    expect(preflightStart).toBeGreaterThan(-1);
    expect(dispatch).toContain('}, ({ client }) => client.session.promptAsync({');
    expect(dispatch).toContain('directory: fusionDirectory');
    expect(dispatch).not.toContain('opencodeClient.sendMessage');
  });
});
