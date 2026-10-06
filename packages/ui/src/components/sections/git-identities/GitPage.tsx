import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useGitIdentitiesStore, type GitIdentityProfile } from '@/stores/useGitIdentitiesStore';
import { useShallow } from 'zustand/react/shallow';
import { GitSettings } from '@/components/sections/openchamber/GitSettings';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';

const ICON_MAP: Record<string, IconName> = {
  branch: 'git-branch',
  briefcase: 'briefcase',
  house: 'home',
  graduation: 'graduation-cap',
  code: 'code',
  heart: 'heart',
};

const COLOR_MAP: Record<string, string> = {
  keyword: 'var(--syntax-keyword)',
  error: 'var(--status-error)',
  string: 'var(--syntax-string)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
};

export const GitPage: React.FC = () => {
  const { t } = useI18n();
  const {
    profiles,
    globalIdentity,
    defaultGitIdentityId,
    loadProfiles,
    loadGlobalIdentity,
    loadDefaultGitIdentityId,
    setDefaultGitIdentityId,
  } = useGitIdentitiesStore(useShallow((s) => ({
    profiles: s.profiles,
    globalIdentity: s.globalIdentity,
    defaultGitIdentityId: s.defaultGitIdentityId,
    loadProfiles: s.loadProfiles,
    loadGlobalIdentity: s.loadGlobalIdentity,
    loadDefaultGitIdentityId: s.loadDefaultGitIdentityId,
    setDefaultGitIdentityId: s.setDefaultGitIdentityId,
  })));

  React.useEffect(() => {
    loadProfiles();
    loadGlobalIdentity();
    loadDefaultGitIdentityId();
  }, [loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId]);

  const handleToggleDefault = async (profileId: string) => {
    const next = defaultGitIdentityId === profileId ? null : profileId;
    const ok = await setDefaultGitIdentityId(next);
    if (!ok) {
      toast.error(t('settings.gitIdentities.page.toast.updateDefaultFailed'));
      return;
    }
    toast.success(next ? t('settings.gitIdentities.page.toast.defaultUpdated') : t('settings.gitIdentities.page.toast.defaultUnset'));
  };

  return (
    <SettingsPageLayout
        title={t('settings.page.git.title')}
        showSaveStatus
      >
        <SettingsSection
          title={t('settings.gitIdentities.page.section.title')}
          divider={false}
          settingsItem="git.identities"
        >
          <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
            {/* Global identity */}
            {globalIdentity && (
              <IdentityRow
                profile={globalIdentity}
                isDefault={defaultGitIdentityId === 'global'}
                onToggleDefault={() => handleToggleDefault('global')}
                isSystem
                hasBorder={profiles.length > 0}
              />
            )}

            {/* Custom profiles */}
            {profiles.map((profile, i) => (
              <IdentityRow
                key={profile.id}
                profile={profile}
                isDefault={defaultGitIdentityId === profile.id}
                onToggleDefault={() => handleToggleDefault(profile.id)}
                hasBorder={i < profiles.length - 1}
              />
            ))}

            {/* Empty state */}
            {!globalIdentity && profiles.length === 0 && (
              <div className="py-8 px-4 text-center text-muted-foreground">
                <Icon name="shield-keyhole" className="mx-auto mb-2 h-8 w-8 opacity-40" />
                <p className="typography-ui-label">{t('settings.gitIdentities.page.empty.title')}</p>
                <p className="typography-meta mt-1 opacity-75">{t('settings.gitIdentities.page.empty.description')}</p>
              </div>
            )}

          </div>
        </SettingsSection>

        <GitSettings />
    </SettingsPageLayout>
  );
};

// --- Identity row ---

interface IdentityRowProps {
  profile: GitIdentityProfile;
  isDefault: boolean;
  onToggleDefault: () => void;
  isSystem?: boolean;
  hasBorder?: boolean;
}

const IdentityRow: React.FC<IdentityRowProps> = ({
  profile,
  isDefault,
  onToggleDefault,
  isSystem,
  hasBorder,
}) => {
  const { t } = useI18n();
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const iconName = ICON_MAP[profile.icon || 'branch'] || 'git-branch';
  const iconColor = COLOR_MAP[profile.color || ''];
  const authType = profile.authType || 'ssh';

  const renderMenuItems = (Item: React.ElementType) => (
    <>
      <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onToggleDefault(); }}>
        {isDefault ? t('settings.gitIdentities.page.actions.unsetDefault') : t('settings.gitIdentities.page.actions.setAsDefault')}
      </Item>
    </>
  );

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
      <ContextMenuTrigger
        render={
          <div
            className={cn(
              'group flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--interactive-hover)]/30',
              hasBorder && 'border-b border-[var(--surface-subtle)]'
            )}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenuOpen(true);
            }}
          />
        }
      >
      <div className="flex items-center gap-3 min-w-0">
        <Icon name={iconName} className="w-4 h-4 shrink-0" style={{ color: iconColor }} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="typography-ui-label text-foreground truncate">{profile.name}</span>
            <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
              {authType}
            </span>
            {isDefault && (
              <span className="typography-micro text-primary bg-primary/12 px-1 rounded flex-shrink-0 leading-none pb-px border border-primary/25">
                {t('settings.gitIdentities.page.badge.default')}
              </span>
            )}
            {isSystem && (
              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                {t('settings.agents.sidebar.badge.system')}
              </span>
            )}
          </div>
          <div className="typography-micro text-muted-foreground/60 truncate leading-tight">
            {authType === 'token' && profile.host ? profile.host : profile.userEmail}
          </div>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name="more-2" className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-fit min-w-28">
          {renderMenuItems(DropdownMenuItem)}
        </DropdownMenuContent>
      </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-fit min-w-28">
        {renderMenuItems(ContextMenuItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
};
