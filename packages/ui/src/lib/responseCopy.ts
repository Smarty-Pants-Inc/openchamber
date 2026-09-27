/** Reads a copy of a response's body alongside its caller; null when it cannot be copied (already read). Never throws. */
export const readCopy = (response: Response, as: 'arrayBuffer' | 'json' = 'arrayBuffer'): Promise<unknown> | null => {
  try {
    if (response.bodyUsed || !response.body) return null;
    const copy = response.clone();
    return (as === 'json' ? copy.json() : copy.arrayBuffer()).catch(() => undefined);
  } catch { return null; }
};
