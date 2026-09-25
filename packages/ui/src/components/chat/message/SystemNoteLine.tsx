import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { formatTimestampForDisplay } from './timeFormat';
import type { ChatMessageEntry } from '../lib/turns/types';

/** A system note (see systemNote.ts) as one quiet line with its time, outside any turn. */
export const SystemNoteLine: React.FC<{ message: ChatMessageEntry }> = ({ message }) => {
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const text = message.parts.flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text.trim()] : [])
        .filter(Boolean).join(' ');
    const created = (message.info as { time?: { created?: number } }).time?.created;
    const time = typeof created === 'number' ? formatTimestampForDisplay(created, timeFormatPreference) : '';
    if (!text) return null;
    return (
        <div role="note" data-system-note="" className="chat-message-column my-1 flex justify-center">
            <p className="max-w-full truncate text-xs text-muted-foreground">
                {text}{time ? <span className="ml-1.5 tabular-nums opacity-80">{time}</span> : null}
            </p>
        </div>
    );
};
