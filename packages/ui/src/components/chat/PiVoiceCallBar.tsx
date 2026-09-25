import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { endActivePiVoiceCall, useActivePiVoiceCall } from '@/lib/voice/piVoiceActiveCall';
import { useDirectoryStore } from '@/sync/sync-context';

const PHASES = ['connecting', 'listening', 'working', 'speaking', 'muted'] as const;
const knownPhase = (value: string | undefined) => PHASES.find(phase => phase === value);

/**
 * The page's live voice call, on every screen: its phase, the session it belongs to when that is
 * not the one in view, and End voice call. It does not depend on what the current view can do
 * (a new draft, a view-only or voiceless session), so a running call always has a visible End.
 */
export function PiVoiceCallBar({ viewedSessionId }: { viewedSessionId: string | null }) {
  const { t } = useI18n();
  const call = useActivePiVoiceCall();
  const store = useDirectoryStore(call?.directory);
  const title = React.useSyncExternalStore(store.subscribe,
    () => store.getState().session.find(session => session.id === call?.sessionId)?.title?.trim() || undefined,
    () => undefined);
  if (!call) return null;
  const state = call.state;
  const phase = state.status === 'active' && state.muted ? 'muted'
    : knownPhase(state.status === 'active' ? state.phase : 'connecting');
  const elsewhere = call.sessionId !== viewedSessionId;
  const line = state.status === 'active' && state.transcript
    ? t(state.transcript.role === 'user' ? 'chat.piVoice.you' : 'chat.piVoice.agent', { text: state.transcript.text }) : undefined;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={line}>
      {phase ? <span aria-live="polite" className="whitespace-nowrap">{t(`chat.piVoice.phase.${phase}`)}</span> : null}
      {elsewhere ? <span className="min-w-0 truncate">{t('chat.piVoice.inSession', { title: title ?? call.sessionId.slice(0, 8) })}</span> : null}
      <Button type="button" variant="chip" size="xs" aria-label={t('chat.piVoice.end')} title={t('chat.piVoice.end')}
        onClick={() => endActivePiVoiceCall()}>
        <Icon name="mic" className="size-3.5" />
      </Button>
    </span>
  );
}
