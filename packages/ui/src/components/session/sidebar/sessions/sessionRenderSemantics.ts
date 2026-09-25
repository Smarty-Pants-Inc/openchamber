import type { Session } from '@opencode-ai/sdk/v2';
import { herdrSignature } from '@/lib/herdrSession';

/** The session fields a sidebar row renders; a Herdr-only state change must re-render its dot (OC#177 review). */
export const areSessionRenderSemanticsEqual = (prev: Session, next: Session): boolean => (
  prev.id === next.id
  && prev.title === next.title
  && prev.directory === next.directory
  && prev.parentID === next.parentID
  && prev.share?.url === next.share?.url
  && prev.time?.created === next.time?.created
  && prev.time?.updated === next.time?.updated
  && prev.time?.archived === next.time?.archived
  && herdrSignature(prev) === herdrSignature(next)
);
