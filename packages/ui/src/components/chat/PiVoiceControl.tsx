import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { piVoiceTransport, startPiVoiceCall, type PiVoiceState } from '@/lib/voice/piVoiceCall';
import { browserPiVoiceMedia, supportsPiVoice } from '@/lib/voice/piVoiceMedia';

type Call = Awaited<ReturnType<typeof startPiVoiceCall>>;
type ControlState = { status: 'idle' } | { status: 'starting' } | PiVoiceState;
const PHASES = ['connecting', 'listening', 'working', 'speaking', 'muted', 'error', 'standby'] as const;
const knownPhase = (value: string | undefined) => PHASES.find(phase => phase === value);

/** One live voice call with the selected ordinary Pi session; the session's /live engine does the rest. */
export function PiVoiceControl({ sessionId, directory, start = startPiVoiceCall }: {
  sessionId: string; directory: string; start?: typeof startPiVoiceCall;
}) {
  const { t } = useI18n();
  const [state, setState] = React.useState<ControlState>({ status: 'idle' });
  const call = React.useRef<Call | undefined>(undefined);
  // Leaving the session or page ends its call and releases the microphone.
  React.useEffect(() => () => { void call.current?.hangup(); call.current = undefined; }, [sessionId, directory]);
  if (!supportsPiVoice()) return null;
  const active = state.status === 'starting' || state.status === 'active';
  const toggle = async () => {
    if (active) { await call.current?.hangup(); return; }
    setState({ status: 'starting' });
    try {
      call.current = await start(piVoiceTransport(sessionId, directory), browserPiVoiceMedia(), next => {
        setState(next);
        if (next.status === 'ended') {
          call.current = undefined;
          if (next.error) toast.error(t('chat.piVoice.ended', { reason: next.error }));
        }
      });
    } catch (error) {
      setState({ status: 'idle' });
      toast.error(t('chat.piVoice.failed', { reason: error instanceof Error ? error.message : String(error) }));
    }
  };
  const phase = knownPhase(state.status === 'active' ? state.phase : state.status === 'starting' ? 'connecting' : undefined);
  const label = active ? t('chat.piVoice.end') : t('chat.piVoice.start');
  return (
    <Button type="button" variant="chip" size="xs" aria-pressed={active} aria-label={label}
      title={state.status === 'active' && state.transcript ? state.transcript.text : label}
      disabled={state.status === 'starting'} onClick={() => { void toggle(); }}>
      <Icon name="mic" className="size-3.5" />
      {phase ? <span aria-live="polite">{t(`chat.piVoice.phase.${phase}`)}</span> : null}
    </Button>
  );
}
