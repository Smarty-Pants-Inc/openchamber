import { z } from 'zod';

const Outcome = z.object({ success: z.boolean().optional() });

/** Whether a copy of the response's JSON body says `success: false`, read alongside its caller. False when it cannot
 * be read (already read, no body, not JSON). Never throws. */
export const answersUnsuccessful = async (response: Response): Promise<boolean> => {
  try {
    if (response.bodyUsed || !response.body) return false;
    const parsed = Outcome.safeParse(await response.clone().json());
    return parsed.success && parsed.data.success === false;
  } catch { return false; }
};
