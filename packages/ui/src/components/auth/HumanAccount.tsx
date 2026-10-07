import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { clearGoogleSignInError, humanAuthClient, readGoogleSignInError, signInWithGoogle } from '@/lib/human-auth';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent } from '@/lib/runtime-switch';

type Profile = { id: string; name: string; email: string; image?: string | null };

const initials = (profile: Profile | null) => (profile?.name || profile?.email || '?')
  .split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();

// ponytail: the client has no organization record yet; this deployment is one org. #380 adds orgs and switching.
const ORGANIZATION = 'Smarty Pants';

export function GoogleSignIn() {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState(readGoogleSignInError);
  React.useEffect(clearGoogleSignInError, []);
  return <div className="space-y-3">
    <p className="typography-ui-meta text-muted-foreground">{t('chat.displayName.googleHelp')}</p>
    <Button disabled={busy} onClick={async () => {
      setBusy(true); setRefusal(null);
      try { await signInWithGoogle(); } catch { setRefusal('failed'); }
      finally { setBusy(false); }
    }}>{t('chat.displayName.googleSignIn')}</Button>
    {refusal && <p role="alert">
      {t(refusal === 'notMember' ? 'chat.displayName.notMember' : 'chat.displayName.accountError')}
    </p>}
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
  const alert = failed && <p role="alert" className="text-destructive">{t('chat.displayName.accountError')}</p>;
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t('chat.displayName.account')}
          className="inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted typography-ui-meta font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {profile?.image
            ? <img src={profile.image} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
            : initials(profile)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]">
        <div className="px-2 py-1.5">
          <p className="truncate typography-ui-label font-medium">{profile?.name || t('chat.displayName.account')}</p>
          {profile?.email && <p className="truncate typography-ui-meta text-muted-foreground">{profile.email}</p>}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center justify-between gap-2 font-normal">
          <span className="text-muted-foreground">{t('chat.displayName.organization')}</span>
          <span className="truncate">{ORGANIZATION}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={!profile} onClick={() => setOpen(true)}>{t('chat.displayName.editProfile')}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !profile} closeOnClick={false} onClick={() => void run('revoke')}>
          {t('chat.displayName.revokeOthers')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} closeOnClick={false} onClick={() => void run('logout')}>{t('chat.displayName.signOut')}</DropdownMenuItem>
        {alert && <div className="px-2 py-1 typography-ui-meta">{alert}</div>}
      </DropdownMenuContent>
    </DropdownMenu>
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
        {alert}
      </DialogContent>
    </Dialog>
  </>;
}
