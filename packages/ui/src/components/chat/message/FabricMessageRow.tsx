import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { FabricMessage } from './fabricMessageData';

/**
 * smarty-code#739: a Fabric message from another agent, delivered into this session. It is not the person's message,
 * so it is a quiet collapsed row with the real sender (from the Fabric envelope); one click shows the text.
 */
export function FabricMessageRow({ fabric, children }: { fabric: FabricMessage; children: React.ReactNode }) {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    return (
        <div className="w-full rounded-lg border border-dashed border-border bg-muted/30 typography-ui-meta text-muted-foreground"
            data-fabric-message="true">
            <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:text-foreground">
                <Icon name="robot" className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">
                    {t('chat.fabric.from')} <span className="font-semibold text-foreground">{fabric.from}</span>
                    {fabric.to && <> {t('chat.fabric.to')} {fabric.to}</>}
                </span>
                {fabric.ref && <span className="ml-auto hidden shrink-0 sm:inline">{fabric.ref}</span>}
                <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className={cn('size-3.5 shrink-0', !fabric.ref && 'ml-auto sm:ml-0')} aria-hidden />
            </button>
            {open && <div className="px-3 pb-2 pl-8 text-foreground">{children}</div>}
        </div>
    );
}
