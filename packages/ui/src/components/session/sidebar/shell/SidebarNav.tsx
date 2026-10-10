import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { SmartiesNavSection } from '@/components/views/feed/FeedNav';
import { useFeedStore } from '@/components/views/feed/feedStore';

// smarty-code#1407: the "Smarties" section leads the nav. While a Smarty fills the app, it is the whole nav: starting a
// session belongs to the old Smarty Code view, behind the nav's bottom button.
// Primary sidebar action: starting a session is the one control worth its own
// row; it keeps the quiet text-row form so the top reads as content, while
// every other control lives in the icon toolbar below.
type Props = {
  onNewSession: () => void;
};

export function SidebarNav(props: Props): React.ReactNode {
  const { t } = useI18n();
  const smartyShown = useFeedStore(state => state.pageOpen);
  return (
    <div className="select-none flex-shrink-0 px-2.5 pt-1.5">
      <SmartiesNavSection />
      {smartyShown ? null : (
        <button
          type="button"
          onClick={props.onNewSession}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left typography-ui-label font-normal text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Icon name="chat-new" className="h-4 w-4 flex-shrink-0" />
          <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
        </button>
      )}
    </div>
  );
}
