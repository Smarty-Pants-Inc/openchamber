/**
 * Reports the fork's unsupported permission auto-accept control.
 *
 * The pointer guards keep a tap from dismissing the mobile keyboard: on
 * Android's resizes-content viewport the keyboard-close relayout moves this
 * button mid-tap and the click never lands.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type PermissionAutoAcceptButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isInteractive: boolean;
    permissionAutoAcceptEnabled: boolean;
    handlePermissionAutoAcceptToggle: () => void;
    withTooltip?: boolean;
};

export const PermissionAutoAcceptButton = React.memo(function PermissionAutoAcceptButton(props: PermissionAutoAcceptButtonProps) {
    const { t } = useI18n();
    const {
        footerIconButtonClass,
        iconSizeClass,
        handlePermissionAutoAcceptToggle,
        withTooltip = false,
    } = props;

    const ariaLabel = t('common.unavailable');
    const tooltipLabel = ariaLabel;

    const button = (
        <button
            type="button"
            onClick={handlePermissionAutoAcceptToggle}
            className={cn(
                footerIconButtonClass,
                'rounded-md opacity-30',
            )}
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            aria-pressed={false}
            aria-disabled="true"
            aria-label={ariaLabel}
            title={ariaLabel}
        >
            <Icon name="shield-user" className={cn(iconSizeClass)} />
        </button>
    );

    if (!withTooltip) {
        return button;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {button}
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {tooltipLabel}
            </TooltipContent>
        </Tooltip>
    );
});
