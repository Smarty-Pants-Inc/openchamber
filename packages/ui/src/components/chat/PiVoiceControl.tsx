import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { endActivePiVoiceCall, startPiVoiceCallFor, useActivePiVoiceCall, type PiVoiceCallDriver } from '@/lib/voice/piVoiceActiveCall';
import { browserPiVoiceMedia, supportsPiVoice } from '@/lib/voice/piVoiceMedia';

// Loaded on first use: the call module brings the runtime socket, not needed to render the chip.
const driver: PiVoiceCallDriver = { media: browserPiVoiceMedia, load: () => import('@/lib/voice/piVoiceCall') };
const PHASES = ['connecting', 'listening', 'working', 'speaking', 'muted'] as const;
const knownPhase = (value: string | undefined) => PHASES.find(phase => phase === value);

/** The page's voice call, bound to the session where it started; the session's engine does the rest. */
export function PiVoiceControl({ sessionId, directory }: { sessionId: string; directory: string }) {
  const { t } = useI18n();
  // VS Code, and surfaces rendered without a runtime provider, show no voice control.
  const unsupportedRuntime = React.useContext(RuntimeAPIContext)?.runtime.isVSCode !== false;
  // Shown only when the gateway advertises session voice for this directory; unknown means hidden.
  const [advertised, setAdvertised] = React.useState<{ runtimeKey: string; directory: string } | null>(null);
  React.useEffect(() => {
    if (unsupportedRuntime || !supportsPiVoice()) return;
    let cancelled = false;
    const runtimeKey = getRuntimeKey();
    opencodeClient.supportsSessionVoice(directory).then(supported => {
      if (!cancelled && supported && getRuntimeKey() === runtimeKey) setAdvertised({ runtimeKey, directory });
    }, () => undefined);
    return () => { cancelled = true; };
  }, [directory, unsupportedRuntime]);
  const current = useActivePiVoiceCall();
  if (unsupportedRuntime || !supportsPiVoice() || advertised?.directory !== directory || advertised.runtimeKey !== getRuntimeKey()) return null;
  const hooks = {
    onEnded: (reason: string) => { toast.error(t('chat.piVoice.ended', { reason })); },
    onFailed: (reason: string) => { toast.error(t('chat.piVoice.failed', { reason })); },
  };
  const here = current?.sessionId === sessionId && current.directory === directory;
  // A call bound to another session: browsing here leaves it running; moving it is explicit.
  if (current && !here) {
    return (
      <span className="inline-flex items-center gap-1">
        <Button type="button" variant="chip" size="xs" aria-label={t('chat.piVoice.moveHere')}
          onClick={() => { void startPiVoiceCallFor(sessionId, directory, driver, hooks); }}>
          <Icon name="mic" className="size-3.5" /><span>{t('chat.piVoice.moveHere')}</span>
        </Button>
        <Button type="button" variant="chip" size="xs" aria-label={t('chat.piVoice.end')} title={t('chat.piVoice.end')}
          onClick={endActivePiVoiceCall}>
          <Icon name="close" className="size-3.5" />
        </Button>
      </span>
    );
  }
  const state = here ? current.state : undefined;
  const active = Boolean(state);
  const phase = state?.status === 'active' && state.muted ? 'muted'
    : knownPhase(state?.status === 'active' ? state.phase : state?.status === 'starting' ? 'connecting' : undefined);
  const label = active ? t('chat.piVoice.end') : t('chat.piVoice.start');
  // The engine's latest line, with the same you:/agent: labels every voice surface shows.
  const line = state?.status === 'active' && state.transcript
    ? t(state.transcript.role === 'user' ? 'chat.piVoice.you' : 'chat.piVoice.agent', { text: state.transcript.text }) : undefined;
  return (
    <Button type="button" variant="chip" size="xs" aria-pressed={active} aria-label={label}
      title={line ?? label}
      disabled={state?.status === 'starting'}
      onClick={() => { if (active) endActivePiVoiceCall(); else void startPiVoiceCallFor(sessionId, directory, driver, hooks); }}>
      <Icon name="mic" className="size-3.5" />
      {phase ? <span aria-live="polite">{t(`chat.piVoice.phase.${phase}`)}</span> : null}
    </Button>
  );
}
