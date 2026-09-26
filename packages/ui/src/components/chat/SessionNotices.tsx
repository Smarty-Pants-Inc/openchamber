import React from 'react';
import { SessionErrorNotice } from '@/components/chat/SessionErrorNotice';
import { SteerOutcomeNotices } from '@/components/chat/SteerOutcomeNotices';

/** The notices at the end of a session's chat: the failed-turn notice, then each steered message that was not sent. */
export const SessionNotices: React.FC<{ sessionId: string; directory?: string }> = ({ sessionId, directory }) => (
  <>
    <SessionErrorNotice sessionId={sessionId} directory={directory} />
    <SteerOutcomeNotices sessionId={sessionId} />
  </>
);
