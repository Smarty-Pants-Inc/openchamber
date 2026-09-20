import { z } from 'zod';

const authorSchema = z.object({
  version: z.literal(1),
  issuer: z.string().url().refine(value => {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }),
  subject: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(128).refine(value => value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/.test(value)),
  image: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }).optional(),
}).strict();
const infoSchema = z.object({ metadata: z.object({ smartyCodeHuman: authorSchema }) });

export function trustedHumanAuthor(info: unknown) {
  const parsed = infoSchema.safeParse(info);
  return parsed.success ? parsed.data.metadata.smartyCodeHuman : undefined;
}

/** Only the server projection owns this metadata. Text and legacy names are never evidence. */
export function HumanAuthor({ info }: { info: unknown }) {
  const author = trustedHumanAuthor(info);
  if (!author) return null;
  return <div className="mb-1 flex items-center gap-1.5 typography-ui-meta text-muted-foreground">
    {author.image && <img src={author.image} alt="" referrerPolicy="no-referrer" className="size-4 rounded-full" />}
    <span className="truncate">{author.name}</span>
  </div>;
}
