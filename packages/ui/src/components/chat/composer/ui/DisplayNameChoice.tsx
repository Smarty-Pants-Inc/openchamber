import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { browserDisplayName, displayNameSchema } from '@/lib/messages/displayName';
import { isIMECompositionEvent } from '@/lib/ime';
import { useHumanAuth } from '@/lib/human-auth';
import { HumanAccount } from '@/components/auth/HumanAccount';

export function DisplayNameChoice() {
  const enabled = useHumanAuth(state => state.enabled);
  return enabled ? <HumanAccount /> : <LegacyDisplayNameChoice />;
}

function LegacyDisplayNameChoice() {
  const { t } = useI18n();
  const id = React.useId();
  const [name, setName] = React.useState('');
  const [saved, setSaved] = React.useState<string>();
  const [error, setError] = React.useState(false);
  const [unnamedForTab, setUnnamedForTab] = React.useState(browserDisplayName.unnamedForTab);
  React.useEffect(() => {
    try {
      const current = browserDisplayName.read();
      setName(current ?? '');
      setSaved(current);
    } catch { setError(true); }
  }, []);
  const apply = () => {
    if (name !== '' && !displayNameSchema.safeParse(name).success) { setError(true); return; }
    try {
      browserDisplayName.apply(name);
      setSaved(name || undefined);
      setUnnamedForTab(false);
      setError(false);
    } catch { setError(true); }
  };
  const useUnnamedForTab = () => {
    browserDisplayName.useUnnamedForTab();
    setName('');
    setSaved(undefined);
    setUnnamedForTab(true);
    setError(false);
  };
  let status = t(unnamedForTab ? 'chat.displayName.unnamedForTab' : 'chat.displayName.unnamed');
  if (saved) status = t('chat.displayName.active', { name: saved });
  if (error) status = t('chat.displayName.error');
  return (
    <div className="mb-2 space-y-1">
      <label htmlFor={id} className="typography-ui-label text-foreground">{t('chat.displayName.label')}</label>
      <div className="flex items-center gap-2">
        <Input id={id} value={name} maxLength={64} aria-invalid={error}
          aria-describedby={`${id}-help ${id}-status`}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (isIMECompositionEvent(event)) return;
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); apply(); }
          }} />
        <Button type="button" size="sm" variant="outline" onClick={apply}>{t('chat.displayName.apply')}</Button>
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={useUnnamedForTab}>
        {t('chat.displayName.useUnnamedForTab')}
      </Button>
      <p id={`${id}-help`} className="typography-ui-meta text-muted-foreground">{t('chat.displayName.help')}</p>
      <p id={`${id}-status`} role="status" className="typography-ui-meta text-muted-foreground">
        {status}
      </p>
    </div>
  );
}
