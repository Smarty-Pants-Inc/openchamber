// smarty-dev#799 L2: "Connect your iPhone". One code per iPhone lets the "Send to my Smarty" Shortcut post a call
// transcript to the person's own Smarty (POST /api/me/share). The code is shown once; the list below names each
// connected device by when it was added and last used, and Remove revokes it.
import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_DESCRIPTION_CLASS, SETTINGS_SECTION_TITLE_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { loadShareShortcutUrl, useShareTokensStore, type ShareToken } from '@/lib/shareTokens';
import { cn } from '@/lib/utils';

const formatDate = (iso: string, withTime = false) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso
    : new Intl.DateTimeFormat(getCurrentIntlLocale(), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
};

function StepTitle({ step, done, children }: { step: number; done?: boolean; children: React.ReactNode }): React.ReactNode {
  return (
    <h2 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'flex items-center gap-2.5')}>
      <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-full typography-ui-label font-semibold',
        done ? 'bg-[var(--status-success-background)] text-[var(--status-success)]' : 'bg-[color-mix(in_srgb,var(--primary-base)_14%,transparent)] text-[var(--primary-base)]')}>
        {done ? <Icon name="check" className="size-4" /> : step}
      </span>
      {children}
    </h2>
  );
}

function CreatedCode({ token }: { token: string }): React.ReactNode {
  const { t } = useI18n();
  const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const onCopy = async () => setCopy((await copyTextToClipboard(token)).ok ? 'copied' : 'failed');
  return (
    <div className="space-y-3" data-share-code>
      <label className="block space-y-1.5">
        <span className="typography-meta font-medium text-foreground">{t('connectIphone.step1.codeLabel')}</span>
        <input readOnly value={token} onFocus={event => event.currentTarget.select()} spellCheck={false}
          className="w-full rounded-lg border border-border/70 bg-[var(--surface-muted)] px-3 py-2.5 font-mono text-base tracking-wide text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={() => void onCopy()}>
          <Icon name={copy === 'copied' ? 'check' : 'file-copy'} className="size-4" />
          {copy === 'copied' ? t('connectIphone.step1.copied') : t('connectIphone.step1.copy')}
        </Button>
        {copy === 'failed' ? <span role="alert" className="typography-meta text-[var(--status-error)]">{t('connectIphone.step1.copyFailed')}</span> : null}
      </div>
      <p className="flex gap-2 rounded-lg bg-[color-mix(in_srgb,var(--status-warning)_12%,transparent)] px-3 py-2.5 typography-meta text-foreground">
        <Icon name="lock" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
        <span><strong className="font-semibold">{t('connectIphone.step1.warning')}</strong> {t('connectIphone.step1.once')}</span>
      </p>
    </div>
  );
}

function DeviceRow({ token, onRemove }: { token: ShareToken; onRemove: () => void }): React.ReactNode {
  const { t } = useI18n();
  const removing = useShareTokensStore(state => state.removing === token.id);
  const failed = useShareTokensStore(state => state.removeFailed === token.id);
  const added = formatDate(token.createdAt);
  return (
    <li className="flex items-center gap-3 py-3" data-share-token={token.id}>
      <Icon name="smartphone" className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="typography-ui-label text-foreground">{t('connectIphone.devices.added', { date: added })}</p>
        <p className="typography-meta text-muted-foreground">
          {token.lastUsedAt ? t('connectIphone.devices.lastUsed', { date: formatDate(token.lastUsedAt, true) }) : t('connectIphone.devices.neverUsed')}
        </p>
        {failed ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t('connectIphone.remove.failed')}</p> : null}
      </div>
      <Button variant="outline" size="sm" disabled={removing} onClick={onRemove} aria-label={t('connectIphone.devices.removeLabel', { date: added })}>
        {t('connectIphone.devices.remove')}
      </Button>
    </li>
  );
}

export function ConnectIphonePage(): React.ReactNode {
  const { t } = useI18n();
  const list = useShareTokensStore(state => state.list);
  const created = useShareTokensStore(state => state.created);
  const creating = useShareTokensStore(state => state.creating);
  const createFailed = useShareTokensStore(state => state.createFailed);
  const [shortcutUrl, setShortcutUrl] = React.useState<string | null | undefined>(undefined);
  const [confirming, setConfirming] = React.useState<ShareToken | null>(null);
  const removingConfirmed = useShareTokensStore(state => confirming !== null && state.removing === confirming.id);

  React.useEffect(() => {
    const { load, forgetCreated } = useShareTokensStore.getState();
    void load();
    let live = true;
    void loadShareShortcutUrl().then(url => { if (live) setShortcutUrl(url); });
    // The code's secret leaves memory with the page.
    return () => { live = false; forgetCreated(); };
  }, []);

  const confirmRemove = async () => {
    if (!confirming) return;
    // A failed removal closes the dialog too; the row says it failed and keeps its Remove button.
    await useShareTokensStore.getState().remove(confirming.id);
    setConfirming(null);
  };

  return (
    <SettingsPageLayout title={t('settings.page.connectIphone.title')} description={t('settings.page.connectIphone.description')} showSaveStatus={false}>
      <SettingsSection title={<StepTitle step={1} done={created !== null}>{t('connectIphone.step1.title')}</StepTitle>} divider={false} settingsItem="connect-iphone.create" contentClassName="space-y-3">
        {created ? <CreatedCode token={created.token} /> : <>
          <p className={SETTINGS_DESCRIPTION_CLASS}>{t('connectIphone.step1.body')}</p>
          <Button size="lg" disabled={creating} onClick={() => void useShareTokensStore.getState().create()}>
            <Icon name="lock" className="size-4" />
            {creating ? t('connectIphone.step1.creating') : t('connectIphone.step1.create')}
          </Button>
          {createFailed ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t('connectIphone.step1.failed')}</p> : null}
        </>}
      </SettingsSection>

      <SettingsSection title={<StepTitle step={2}>{t('connectIphone.step2.title')}</StepTitle>} contentClassName="space-y-3">
        {shortcutUrl === null ? <p className={SETTINGS_DESCRIPTION_CLASS}>{t('connectIphone.step2.soon')}</p> : <>
          <p className={SETTINGS_DESCRIPTION_CLASS}>{t('connectIphone.step2.body')}</p>
          {shortcutUrl ? (
            <Button size="lg" variant={created ? 'default' : 'outline'} asChild>
              <a href={shortcutUrl} target="_blank" rel="noopener noreferrer"><Icon name="external-link" className="size-4" />{t('connectIphone.step2.open')}</a>
            </Button>
          ) : null}
        </>}
      </SettingsSection>

      <SettingsSection title={<StepTitle step={3}>{t('connectIphone.step3.title')}</StepTitle>}>
        <ol className="list-decimal space-y-2 pl-5 typography-ui-label text-foreground marker:text-muted-foreground">
          <li>{t('connectIphone.step3.record')}</li>
          <li>{t('connectIphone.step3.notes')}</li>
          <li>{t('connectIphone.step3.share')}</li>
        </ol>
      </SettingsSection>

      <SettingsSection title={t('connectIphone.devices.title')} settingsItem="connect-iphone.devices">
        {list.state === 'loading' ? <p className={SETTINGS_DESCRIPTION_CLASS}>{t('connectIphone.devices.loading')}</p>
          : list.state === 'failed' ? (
            <div role="alert" className="flex flex-wrap items-center gap-3">
              <span className="typography-meta text-[var(--status-error)]">{t('connectIphone.devices.failed')}</span>
              <Button size="sm" variant="outline" onClick={() => void useShareTokensStore.getState().load()}>{t('connectIphone.devices.retry')}</Button>
            </div>
          ) : list.tokens.length === 0 ? <p className={SETTINGS_DESCRIPTION_CLASS}>{t('connectIphone.devices.empty')}</p>
            : <ul className="divide-y divide-border/60">{list.tokens.map(token => <DeviceRow key={token.id} token={token} onRemove={() => setConfirming(token)} />)}</ul>}
      </SettingsSection>

      <Dialog open={confirming !== null} onOpenChange={open => { if (!open && !removingConfirmed) setConfirming(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('connectIphone.remove.title')}</DialogTitle>
            <DialogDescription>{t('connectIphone.remove.body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={removingConfirmed}>{t('connectIphone.remove.cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmRemove()} disabled={removingConfirmed}>{t('connectIphone.remove.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
}
