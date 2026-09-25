import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeRequestScope, getRuntimeKey, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';
import { startPiVoiceCallFor, useActivePiVoiceCall, type PiVoiceCallDriver } from '@/lib/voice/piVoiceActiveCall';
import { browserPiVoiceMedia, supportsPiVoice } from '@/lib/voice/piVoiceMedia';

// Loaded on first use: the call module brings the runtime socket, not needed to render the chip.
const driver: PiVoiceCallDriver = {
  // The runtime scope is captured in the click: the call connects only through the runtime it started in.
  scope: () => { const scope = captureRuntimeRequestScope(); return { key: scope.runtimeKey, current: () => isRuntimeRequestScopeCurrent(scope) }; },
  media: browserPiVoiceMedia, load: () => import('@/lib/voice/piVoiceCall'),
};

/** Starts a voice call with this session, or moves the page's call here; the session's engine does the rest. */
export function PiVoiceControl({ sessionId, directory }: { sessionId: string; directory: string }) {
  const { t } = useI18n();
  // VS Code, and surfaces rendered without a runtime provider, show no voice control.
  const unsupportedRuntime = React.useContext(RuntimeAPIContext)?.runtime.isVSCode !== false;
  // Whether this session takes calls, and if not, the gateway's plain reason (smarty-code#126). A known "no" shows the
  // control disabled with that reason, so a person sees the call feature exists; unknown stays hidden.
  const [voice, setVoice] = React.useState<{ key: string; available: boolean; reason?: string } | null>(null);
  const voiceKey = JSON.stringify([getRuntimeKey(), sessionId, directory]);
  const current = useActivePiVoiceCall();
  const here = current?.runtimeKey === getRuntimeKey() && current.sessionId === sessionId && current.directory === directory;
  // Read again whenever a call on this session starts or ends, however it ended (the engine, End in the call
  // bar, a move elsewhere): a call can end because the session stopped taking calls.
  React.useEffect(() => {
    if (unsupportedRuntime || !supportsPiVoice()) return;
    let cancelled = false;
    const runtimeKey = getRuntimeKey(), key = JSON.stringify([runtimeKey, sessionId, directory]);
    opencodeClient.sessionVoiceAvailability(sessionId, directory).then(result => {
      if (!cancelled && getRuntimeKey() === runtimeKey) setVoice({ key, ...result });
    }, () => undefined);
    return () => { cancelled = true; };
  }, [sessionId, directory, unsupportedRuntime, here]);
  if (unsupportedRuntime || !supportsPiVoice() || voice?.key !== voiceKey) return null;
  // The live call, its phase and End are PiVoiceCallBar's, on every screen; this control only starts or moves.
  if (here) return null;
  if (!voice.available) {
    const reason = voice.reason ?? t('chat.piVoice.unavailable');
    return <span title={reason} className="inline-flex">
      <Button type="button" variant="chip" size="xs" disabled aria-label={`${t('chat.piVoice.call')}. ${reason}`}>
        <Icon name="phone" className="size-3.5" /><span>{t('chat.piVoice.call')}</span>
      </Button>
    </span>;
  }
  const hooks = {
    onEnded: (reason: string) => { toast.error(t('chat.piVoice.ended', { reason })); },
    onFailed: (reason: string) => { toast.error(t('chat.piVoice.failed', { reason })); },
  };
  const label = current ? t('chat.piVoice.moveHere') : t('chat.piVoice.start');
  return (
    <Button type="button" variant="chip" size="xs" aria-label={label} title={label}
      onClick={() => { void startPiVoiceCallFor(sessionId, directory, driver, hooks); }}>
      <Icon name="phone" className="size-3.5" />
      <span>{current ? label : t('chat.piVoice.call')}</span>
    </Button>
  );
}
