import { expect, test } from 'bun:test';
import { mergeExplicitChange, type ModelPrefs } from './modelPrefsShared';

const a = { providerID: 'p', modelID: 'a' }, b = { providerID: 'p', modelID: 'b' }, r = { providerID: 'q', modelID: 'restored' };
const prefs = (over: Partial<ModelPrefs> = {}): ModelPrefs => ({ favoriteModels: [], hiddenModels: [], collapsedModelProviders: [],
  recentModels: [], recentAgents: [], recentEfforts: {}, ...over });

test('favourites replay the user\'s operation onto the server list, keeping server-only entries', () => {
  const s0 = { providerID: 'q', modelID: 'server-only' };
  // Drag B before A locally ([A, B] -> [B, A]); the server has [A, S, B].
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [b, a] }), prefs({ favoriteModels: [a, s0, b] })))
    .toEqual({ favoriteModels: [b, a, s0] });
  // Add r (newest first) and remove a; S stays.
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [r, a, b] }), prefs({ favoriteModels: [s0, a, b] })))
    .toEqual({ favoriteModels: [s0, r, a, b] });
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [b] }), prefs({ favoriteModels: [a, s0, b] })))
    .toEqual({ favoriteModels: [s0, b] });
  // No-ops: an add already on the server, a remove already gone.
  expect(mergeExplicitChange(prefs({ favoriteModels: [a] }), prefs({ favoriteModels: [b, a] }), prefs({ favoriteModels: [b, a] })))
    .toEqual({ favoriteModels: [b, a] });
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [a] }), prefs({ favoriteModels: [a] })))
    .toEqual({ favoriteModels: [a] });
  // The named neighbour is gone on the server: the entry goes to the end.
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [b, a] }), prefs({ favoriteModels: [s0, b] })))
    .toEqual({ favoriteModels: [s0, b] });
});

test('an effort pick writes only that model\'s effort; a restored model\'s effort is not included', () => {
  const shared = prefs({ recentEfforts: { 'p/a': ['high'] } });
  const local = prefs({ recentEfforts: { 'p/a': ['high'], 'q/restored': ['low'] } });
  expect(mergeExplicitChange(local, prefs({ recentEfforts: { ...local.recentEfforts, 'p/b': ['medium'] } }), shared))
    .toEqual({ recentEfforts: { 'p/a': ['high'], 'p/b': ['medium'] } });
});

test('re-picking the current most recent model changes nothing on the shared copy', () => {
  const shared = prefs({ recentModels: [a] });
  expect(mergeExplicitChange(prefs({ recentModels: [a, r] }), prefs({ recentModels: [a, r] }), shared)).toEqual({});
});
