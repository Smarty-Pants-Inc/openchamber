import { describe, expect, test } from 'bun:test';
import { coeditColor, coeditConflictNoticeKey, parseCoeditConflict } from './coeditData';
import { coeditI18n } from '@/lib/i18n/messages/coedit.i18n';

// smartyfs#18: the client's reading of the server's `coedit-conflict` message (rooms.js broadcastStateless).
describe('co-editing conflicts', () => {
    test('reads the server\'s message', () => {
        expect(parseCoeditConflict(JSON.stringify({ type: 'coedit-conflict', conflict: 'raced', at: 5, recovered: true })))
            .toEqual({ kind: 'raced', at: 5, recovered: true });
    });

    test('ignores anything else: other messages, unknown kinds, junk', () => {
        expect(parseCoeditConflict(JSON.stringify({ type: 'other', conflict: 'raced' }))).toBeNull();
        expect(parseCoeditConflict(JSON.stringify({ type: 'coedit-conflict', conflict: 'rm -rf' }))).toBeNull();
        expect(parseCoeditConflict('not json')).toBeNull();
        expect(parseCoeditConflict('null')).toBeNull();
    });

    test('unverified, raced and escaped show the bridge\'s own recovery notice', () => {
        for (const kind of ['unverified', 'raced', 'escaped'] as const) {
            expect(coeditI18n.en[coeditConflictNoticeKey(kind)]).toBe('Another writer changed this file during your save: check the recovery folder.');
        }
        expect(coeditI18n.en[coeditConflictNoticeKey('interrupted')]).toContain('recovery folder');
    });

    test('every conflict kind has a notice in every language', () => {
        for (const kind of ['changed', 'gone', 'truncated', 'interrupted', 'unverified', 'raced', 'escaped'] as const) {
            for (const dictionary of Object.values(coeditI18n)) expect(dictionary[coeditConflictNoticeKey(kind)]).toBeTruthy();
        }
    });

    test('a person keeps one color', () => {
        expect(coeditColor('Kate')).toEqual(coeditColor('Kate'));
        expect(coeditColor('Kate').color).not.toBe(coeditColor('Paul').color);
    });
});
