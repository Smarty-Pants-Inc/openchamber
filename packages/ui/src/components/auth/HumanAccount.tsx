import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { humanAuthClient, signInWithGoogle } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';

type Profile = { id: string; name: string; image?: string | null };

export function GoogleSignIn() {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  return <div className="space-y-3">
    <p className="typography-ui-meta text-muted-foreground">{t('chat.displayName.googleHelp')}</p>
    <Button disabled={busy} onClick={async () => {
      setBusy(true); setFailed(false);
      try { await signInWithGoogle(); } catch { setFailed(true); }
      finally { setBusy(false); }
    }}>{t('chat.displayName.googleSignIn')}</Button>
    {failed && <p role="alert">{t('chat.displayName.accountError')}</p>}
  </div>;
}

export function HumanAccount() {
  const { t } = useI18n();
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [image, setImage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    const scope = captureRuntimeRequestScope();
    let active = true;
    void humanAuthClient().getSession().then(({ data, error }) => {
      if (!active || !isRuntimeRequestScopeCurrent(scope)) return;
      if (error || !data) { setFailed(true); return; }
      setProfile(data.user); setName(data.user.name); setImage(data.user.image || '');
    }).catch(() => { if (active && isRuntimeRequestScopeCurrent(scope)) setFailed(true); });
    return () => { active = false; };
  }, []);
  const run = async (action: 'save' | 'logout' | 'revoke') => {
    const scope = captureRuntimeRequestScope();
    setBusy(true); setFailed(false);
    try {
      const client = humanAuthClient();
      const result = action === 'save' ? await client.updateUser({ name, image })
        : action === 'logout' ? await client.signOut() : await client.revokeOtherSessions();
      if (!isRuntimeRequestScopeCurrent(scope)) return;
      if (result.error) { setFailed(true); return; }
      if (action === 'logout') useAuthSessionStore.getState().markReauthenticating();
      else if (action === 'save') { setProfile(previous => previous ? { ...previous, name, image } : null); setOpen(false); }
    } catch { if (isRuntimeRequestScopeCurrent(scope)) setFailed(true); }
    finally { if (isRuntimeRequestScopeCurrent(scope)) setBusy(false); }
  };
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={t('chat.displayName.account')}>
      {profile?.image && <img src={profile.image} alt="" referrerPolicy="no-referrer" className="size-5 rounded-full" />}
      <span className="max-w-40 truncate">{profile?.name || t('chat.displayName.account')}</span>
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>{t('chat.displayName.account')}</DialogTitle>
        <DialogDescription>{t('chat.displayName.profileHelp')}</DialogDescription>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void run('save'); }}>
          <SettingsStackedField label={t('chat.displayName.profileName')}>
            <Input value={name} maxLength={128} aria-label={t('chat.displayName.profileName')}
              onChange={event => setName(event.target.value)} disabled={busy || !profile} />
          </SettingsStackedField>
          <SettingsStackedField label={t('chat.displayName.profileImage')}>
            <Input value={image} type="url" maxLength={2048} aria-label={t('chat.displayName.profileImage')}
              onChange={event => setImage(event.target.value)} disabled={busy || !profile} />
          </SettingsStackedField>
          <Button type="submit" disabled={busy || !profile || !name.trim()}>{t('chat.displayName.saveProfile')}</Button>
        </form>
        <Button variant="outline" disabled={busy || !profile} onClick={() => void run('revoke')}>
          {t('chat.displayName.revokeOthers')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void run('logout')}>{t('chat.displayName.signOut')}</Button>
        {failed && <p role="alert" className="text-destructive">{t('chat.displayName.accountError')}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
