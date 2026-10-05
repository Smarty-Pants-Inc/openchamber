import { expect, test } from 'bun:test';
import { buildRuntimeAuthHeaders, clearRuntimeAuthCredentialProvider, getRuntimeAuthGeneration, resetRuntimeAuthGeneration, setRuntimeAuthCredentialProvider, setRuntimeBearerToken, setRuntimeExtraHeaders, setRuntimeUrlAuthToken, subscribeRuntimeAuthGenerationChanged } from './runtime-auth';

test('generation notification sees replacement provider, retains existing header semantics and owns unsubscribe', async () => {
  const seen: Promise<Headers>[] = [];
  const generations: number[] = [];
  const stop = subscribeRuntimeAuthGenerationChanged(() => {
    generations.push(getRuntimeAuthGeneration());
    seen.push(buildRuntimeAuthHeaders());
  });
  try {
    setRuntimeBearerToken('controlled-first'); await seen.at(-1);
    setRuntimeAuthCredentialProvider(() => ({ type: 'bearer', token: 'controlled-provider' })); await seen.at(-1);
    clearRuntimeAuthCredentialProvider(); await seen.at(-1);
    setRuntimeExtraHeaders({ 'x-controlled': 'fixture' }); await seen.at(-1);
    resetRuntimeAuthGeneration(); await seen.at(-1);
    expect(generations).toHaveLength(5);
    expect(new Set(generations).size).toBe(5);
    const headers = await Promise.all(seen);
    expect(headers[0].get('authorization')).toBe('Bearer controlled-first');
    expect(headers[1].get('authorization')).toBe('Bearer controlled-provider');
    expect(headers[2].has('authorization')).toBe(false);
    expect(headers[3].get('x-controlled')).toBe('fixture');
    setRuntimeUrlAuthToken('controlled-url-token', Date.now() + 60000);
    setRuntimeUrlAuthToken('controlled-url-token-replacement', Date.now() + 60000);
    expect(generations).toHaveLength(5);
    stop(); setRuntimeBearerToken('controlled-last');
    expect(generations).toHaveLength(5);
  } finally { stop(); setRuntimeExtraHeaders(null); clearRuntimeAuthCredentialProvider(); }
});
