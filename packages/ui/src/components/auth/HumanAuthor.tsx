import { VoiceRequestLabel } from '@/components/chat/message/VoiceTurn';
import { isVoiceRequest } from '@/components/chat/message/voiceTurnData';
import { trustedHumanAuthor } from './human-author-data';

/** Only the server projection owns this metadata. Text and legacy names are never evidence. */
export function HumanAuthor({ info }: { info: unknown }) {
  const author = trustedHumanAuthor(info);
  // smarty-code#538: a voice delegation (the gateway's metadata.smartyVoice.request) reads "You said", like Herdr.
  const voice = isVoiceRequest(info);
  if (!author && !voice) return null;
  return <div className="mb-1 flex items-center gap-1.5 typography-ui-meta text-muted-foreground">
    {voice && <VoiceRequestLabel />}
    {author?.image && <img src={author.image} alt="" referrerPolicy="no-referrer" className="size-4 rounded-full" />}
    {author && <span className="truncate">{author.name}</span>}
  </div>;
}
