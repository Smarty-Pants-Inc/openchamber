import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { PiVoiceState, startPiVoiceCall } from '@/lib/voice/piVoiceCall';
import { browserPiVoiceMedia, supportsPiVoice } from '@/lib/voice/piVoiceMedia';

type Call = ReturnType<typeof startPiVoiceCall>;
// Loaded on first use: the call module brings the runtime socket, not needed to render the chip.
const loadCall = () => import('@/lib/voice/piVoiceCall');
type ControlState = { status: 'idle' } | { status: 'starting' } | PiVoiceState;
const PHASES = ['connecting', 'listening', 'working', 'speaking', 'muted'] as const;
const knownPhase = (value: string | undefined) => PHASES.find(phase => phase === value);

/** One live voice call with the selected ordinary Pi session; the session's /live engine does the rest. */
export function PiVoiceControl({ sessionId, directory }: { sessionId: string; directory: string }) {
  const { t } = useI18n();
  // VS Code, and surfaces rendered without a runtime provider, show no voice control.
  const unsupportedRuntime = React.useContext(RuntimeAPIContext)?.runtime.isVSCode !== false;
  const [state, setState] = React.useState<ControlState>({ status: 'idle' });
  // Whether this session takes calls, and if not, the gateway's plain reason (smarty-code#126). A known "no" shows the
  // control disabled with that reason, so a person sees the call feature exists; unknown stays hidden.
  const [voice, setVoice] = React.useState<{ key: string; available: boolean; reason?: string } | null>(null);
  const [checks, recheck] = React.useReducer((value: number) => value + 1, 0);
  const voiceKey = JSON.stringify([getRuntimeKey(), sessionId, directory]);
  React.useEffect(() => {
    if (unsupportedRuntime || !supportsPiVoice()) return;
    let cancelled = false;
    const runtimeKey = getRuntimeKey(), key = JSON.stringify([runtimeKey, sessionId, directory]);
    opencodeClient.sessionVoiceAvailability(sessionId, directory).then(result => {
      if (!cancelled && getRuntimeKey() === runtimeKey) setVoice({ key, ...result });
    }, () => undefined);
    return () => { cancelled = true; };
  }, [sessionId, directory, unsupportedRuntime, checks]);
  const call = React.useRef<Call | undefined>(undefined);
  // Leaving the session or page ends its call.
  const generation = React.useRef(0);
  // Ends this control's call, including one still starting, and releases the microphone.
  const cancel = React.useCallback(() => { generation.current++; call.current?.hangup(); call.current = undefined; }, []);
  React.useEffect(() => {
    // A page that is unloaded (not merely backgrounded) ends its call. A page kept in the back/forward
    // cache loses its socket, and the call then ends with a reason rather than silently.
    const leave = (event: PageTransitionEvent) => { if (!event.persisted) cancel(); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); cancel(); };
  }, [sessionId, directory, cancel]);
  if (unsupportedRuntime || !supportsPiVoice() || voice?.key !== voiceKey) return null;
  if (!voice.available && state.status !== 'active' && state.status !== 'starting') {
    const reason = voice.reason ?? t('chat.piVoice.unavailable');
    return <span title={reason} className="inline-flex">
      <Button type="button" variant="chip" size="xs" disabled aria-label={`${t('chat.piVoice.call')}. ${reason}`}>
        <Icon name="phone" className="size-3.5" /><span>{t('chat.piVoice.call')}</span>
      </Button>
    </span>;
  }
  const active = state.status === 'starting' || state.status === 'active';
  const toggle = async () => {
    if (active) { call.current?.hangup(); return; }
    const owner = generation.current;
    setState({ status: 'starting' });
    try {
      // One gesture: audio and the microphone are prepared inside the click. A denied
      // microphone starts no call.
      const media = browserPiVoiceMedia(), prepared = media.prepare();
      const voice = await loadCall().catch((error: Error) => { void prepared.catch(() => undefined); media.close(); throw error; });
      const started = await voice.beginPiVoiceCall(prepared, media, () => voice.openPiVoiceSocket(sessionId, directory), next => {
        if (generation.current !== owner) return;
        setState(next);
        if (next.status === 'ended') {
          call.current = undefined;
          recheck(); // a call can end because the session stopped taking calls
          if (next.error) toast.error(t('chat.piVoice.ended', { reason: next.error }));
        }
      }, () => generation.current === owner);
      call.current = started;
    } catch (error) {
      if (generation.current !== owner) return;
      setState({ status: 'idle' });
      toast.error(t('chat.piVoice.failed', { reason: error instanceof Error ? error.message : String(error) }));
    }
  };
  const phase = state.status === 'active' && state.muted ? 'muted'
    : knownPhase(state.status === 'active' ? state.phase : state.status === 'starting' ? 'connecting' : undefined);
  const label = active ? t('chat.piVoice.end') : t('chat.piVoice.start');
  // The engine's latest line, with the same you:/agent: labels every voice surface shows.
  const line = state.status === 'active' && state.transcript
    ? t(state.transcript.role === 'user' ? 'chat.piVoice.you' : 'chat.piVoice.agent', { text: state.transcript.text }) : undefined;
  return (
    <Button type="button" variant="chip" size="xs" aria-pressed={active} aria-label={label}
      title={line ?? label}
      disabled={state.status === 'starting'} onClick={() => { void toggle(); }}>
      <Icon name="phone" className="size-3.5" />
      <span aria-live="polite">{phase ? t(`chat.piVoice.phase.${phase}`) : t('chat.piVoice.call')}</span>
    </Button>
  );
}
