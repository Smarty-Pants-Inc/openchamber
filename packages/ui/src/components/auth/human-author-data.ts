import { z } from 'zod';

const hasForbiddenNameCharacter = (value: string) => Array.from(value).some(character => {
  const code = character.codePointAt(0)!;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x061c
    || (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069) || character === '<' || character === '>';
});

const authorSchema = z.object({
  version: z.literal(1),
  issuer: z.string().url().refine(value => {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }),
  subject: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(128).refine(value => value === value.trim() && !hasForbiddenNameCharacter(value)),
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

// A user message typed in Herdr's terminal (Pi's own input event said so). The server names the fleet owner when one is
// configured, and omits the name otherwise (MVP 1 G4/G5).
const terminalSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(128).refine(value => value === value.trim() && !hasForbiddenNameCharacter(value)).optional(),
}).strict();
const terminalInfoSchema = z.object({ metadata: z.object({ smartyCodeTerminal: terminalSchema }) });

export function trustedTerminalAuthor(info: unknown) {
  const parsed = terminalInfoSchema.safeParse(info);
  return parsed.success ? parsed.data.metadata.smartyCodeTerminal : undefined;
}
