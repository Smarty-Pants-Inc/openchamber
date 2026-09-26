import React from 'react';
import { SessionErrorNotice } from '@/components/chat/SessionErrorNotice';
import { SteerOutcomeNotices } from '@/components/chat/SteerOutcomeNotices';
import { TerminalDialogNotice } from '@/components/chat/TerminalDialogNotice';

/**
 * The notices at the end of a session's chat: the failed-turn notice, each steered message that was not sent, and a
 * dialog waiting in Pi's terminal.
 */
export const SessionNotices: React.FC<{ sessionId: string; directory?: string }> = ({ sessionId, directory }) => (
  <>
    <SessionErrorNotice sessionId={sessionId} directory={directory} />
    <SteerOutcomeNotices sessionId={sessionId} />
    <TerminalDialogNotice sessionId={sessionId} directory={directory} />
  </>
);
