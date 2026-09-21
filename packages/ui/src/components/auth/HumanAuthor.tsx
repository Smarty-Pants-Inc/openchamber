import { trustedHumanAuthor } from './human-author-data';

/** Only the server projection owns this metadata. Text and legacy names are never evidence. */
export function HumanAuthor({ info }: { info: unknown }) {
  const author = trustedHumanAuthor(info);
  if (!author) return null;
  return <div className="mb-1 flex items-center gap-1.5 typography-ui-meta text-muted-foreground">
    {author.image && <img src={author.image} alt="" referrerPolicy="no-referrer" className="size-4 rounded-full" />}
    <span className="truncate">{author.name}</span>
  </div>;
}
