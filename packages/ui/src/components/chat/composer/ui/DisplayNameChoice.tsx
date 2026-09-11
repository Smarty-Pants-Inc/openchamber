import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { displayNameSchema, readDisplayName, saveDisplayName } from '@/lib/messages/displayName';

export function DisplayNameChoice() {
  const { t } = useI18n();
  const id = React.useId();
  const [name, setName] = React.useState('');
  const [saved, setSaved] = React.useState<string>();
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    try {
      const current = readDisplayName(window.sessionStorage);
      setName(current ?? '');
      setSaved(current);
    } catch { setError(true); }
  }, []);
  const apply = () => {
    if (name !== '' && !displayNameSchema.safeParse(name).success) { setError(true); return; }
    try {
      saveDisplayName(window.sessionStorage, name);
      setSaved(name || undefined);
      setError(false);
    } catch { setError(true); }
  };
  let status = t('chat.displayName.unnamed');
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
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); apply(); }
          }} />
        <Button type="button" size="sm" variant="outline" onClick={apply}>{t('chat.displayName.apply')}</Button>
      </div>
      <p id={`${id}-help`} className="typography-ui-meta text-muted-foreground">{t('chat.displayName.help')}</p>
      <p id={`${id}-status`} role="status" className="typography-ui-meta text-muted-foreground">
        {status}
      </p>
    </div>
  );
}
