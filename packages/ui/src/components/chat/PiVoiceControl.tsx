import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useI18n } from '@/lib/i18n';
import type { PiVoiceState, startPiVoiceCall } from '@/lib/voice/piVoiceCall';
import { browserPiVoiceAudio, supportsPiVoice } from '@/lib/voice/piVoiceMedia';

type Call = ReturnType<typeof startPiVoiceCall>;
// Loaded on first use: the call module brings the runtime socket, not needed to render the chip.
const loadCall = () => import('@/lib/voice/piVoiceCall');
type ControlState = { status: 'idle' } | { status: 'starting' } | PiVoiceState;
const PHASES = ['connecting', 'listening', 'working', 'speaking', 'muted', 'error', 'standby'] as const;
const knownPhase = (value: string | undefined) => PHASES.find(phase => phase === value);

/** One live voice call with the selected ordinary Pi session; the session's /live engine does the rest. */
export function PiVoiceControl({ sessionId, directory }: { sessionId: string; directory: string }) {
  const { t } = useI18n();
  // VS Code, and surfaces rendered without a runtime provider, show no voice control.
  const unsupportedRuntime = React.useContext(RuntimeAPIContext)?.runtime.isVSCode !== false;
  const [state, setState] = React.useState<ControlState>({ status: 'idle' });
  const call = React.useRef<Call | undefined>(undefined);
  // Leaving the session or page ends its call (also one still starting) and releases the microphone.
  const generation = React.useRef(0);
  React.useEffect(() => () => { generation.current++; call.current?.hangup(); call.current = undefined; }, [sessionId, directory]);
  if (unsupportedRuntime || !supportsPiVoice()) return null;
  const active = state.status === 'starting' || state.status === 'active';
  const toggle = async () => {
    if (active) { call.current?.hangup(); return; }
    const owner = generation.current;
    setState({ status: 'starting' });
    try {
      // Audio is created inside the click so autoplay policy allows the remote voice.
      const audio = browserPiVoiceAudio();
      const voice = await loadCall().catch((error: Error) => { audio.close(); throw error; });
      if (generation.current !== owner) { audio.close(); return; }
      call.current = voice.startPiVoiceCall(voice.openPiVoiceSocket(sessionId, directory), audio, next => {
        if (generation.current !== owner) return;
        setState(next);
        if (next.status === 'ended') {
          call.current = undefined;
          if (next.error) toast.error(t('chat.piVoice.ended', { reason: next.error }));
        }
      });
    } catch (error) {
      if (generation.current !== owner) return;
      setState({ status: 'idle' });
      toast.error(t('chat.piVoice.failed', { reason: error instanceof Error ? error.message : String(error) }));
    }
  };
  const phase = knownPhase(state.status === 'active' ? state.phase : state.status === 'starting' ? 'connecting' : undefined)
    ?? (state.status === 'active' && state.live ? 'listening' : undefined);
  const label = active ? t('chat.piVoice.end') : t('chat.piVoice.start');
  return (
    <Button type="button" variant="chip" size="xs" aria-pressed={active} aria-label={label}
      title={state.status === 'active' && state.error ? state.error : label}
      disabled={state.status === 'starting'} onClick={() => { void toggle(); }}>
      <Icon name="mic" className="size-3.5" />
      {phase ? <span aria-live="polite">{t(`chat.piVoice.phase.${phase}`)}</span> : null}
    </Button>
  );
}
