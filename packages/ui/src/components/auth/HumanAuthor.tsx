import { formatMessage, useI18nStore } from '@/lib/i18n';
import { trustedHumanAuthor, trustedTerminalAuthor } from './human-author-data';

/** Only the server projection owns this metadata. Text and legacy names are never evidence. */
export function HumanAuthor({ info }: { info: unknown }) {
  const author = trustedHumanAuthor(info);
  if (!author) {
    const terminal = trustedTerminalAuthor(info);
    if (!terminal) return null;
    return <div className="mb-1 flex items-center gap-1.5 typography-ui-meta text-muted-foreground">
      <span className="truncate">{terminal.name
        ? formatMessage(useI18nStore.getState().dictionary, 'chat.author.inHerdr', { name: terminal.name })
        : formatMessage(useI18nStore.getState().dictionary, 'chat.author.inHerdrUnnamed')}</span>
    </div>;
  }
  return <div className="mb-1 flex items-center gap-1.5 typography-ui-meta text-muted-foreground">
    {author.image && <img src={author.image} alt="" referrerPolicy="no-referrer" className="size-4 rounded-full" />}
    <span className="truncate">{author.name}</span>
  </div>;
}
