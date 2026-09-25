import { describe, expect, it } from 'vitest';
import { lastAssistantReply, latestReplyId } from './runtime.js';

// smarty-voice call notes reach OpenChamber as clientRole 'system-note' records in the assistant container.
const user = (id) => ({ info: { id, role: 'user' } });
const reply = (id) => ({ info: { id, role: 'assistant', parentID: 'ask' } });
const note = (id) => ({ info: { id, role: 'assistant', clientRole: 'system-note', parentID: 'ask' } });

describe('session assist reads the agent\'s reply, never a system note', () => {
  it('a call note after the reply is skipped', () => {
    expect(lastAssistantReply([user('ask'), reply('r'), note('call-end')])?.info.id).toBe('r');
    expect(latestReplyId([user('ask'), reply('r'), note('call-end')])).toBe('r');
  });
  it('a note alone is no reply: nothing to suggest from, and a newer question still wins', () => {
    expect(lastAssistantReply([user('ask'), note('call-start')])).toBeNull();
    expect(latestReplyId([reply('old'), user('ask'), note('call-start')])).toBeNull();
    expect(latestReplyId(null)).toBeNull();
  });
});
