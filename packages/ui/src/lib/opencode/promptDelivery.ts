import { toast } from '@/components/ui';
import { formatMessage, useI18nStore } from '@/lib/i18n';

/** The server steered a message into the running turn (co-steer, MVP 1 G5): say so plainly. */
export function announceSteered(sessionTitle: string | undefined) {
  const dictionary = useI18nStore.getState().dictionary;
  const name = sessionTitle?.trim();
  toast.success(name ? formatMessage(dictionary, 'chat.coSteer.delivered', { name }) : formatMessage(dictionary, 'chat.coSteer.deliveredUnnamed'));
}
