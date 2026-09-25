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
  const here = current?.runtimeKey === getRuntimeKey() && current.sessionId === sessionId && current.directory === directory;
  // The live call, its phase and End are PiVoiceCallBar's, on every screen; this control only starts or moves.
  if (here) return null;
  const label = current ? t('chat.piVoice.moveHere') : t('chat.piVoice.start');
  return (
    <Button type="button" variant="chip" size="xs" aria-label={label} title={label}
      onClick={() => { void startPiVoiceCallFor(sessionId, directory, driver, hooks); }}>
      <Icon name="mic" className="size-3.5" />
      {current ? <span>{label}</span> : null}
    </Button>
  );
}
