import { expect, test } from 'bun:test';
import { mergeExplicitChange, type ModelPrefs } from './modelPrefsShared';

const a = { providerID: 'p', modelID: 'a' }, b = { providerID: 'p', modelID: 'b' }, r = { providerID: 'q', modelID: 'restored' };
const prefs = (over: Partial<ModelPrefs> = {}): ModelPrefs => ({ favoriteModels: [], hiddenModels: [], collapsedModelProviders: [],
  recentModels: [], recentAgents: [], recentEfforts: {}, ...over });

test('favourites are written in the user\'s order: a drag, a new favourite first, a removal', () => {
  const shared = prefs({ favoriteModels: [a, b] });
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [b, a] }), shared)).toEqual({ favoriteModels: [b, a] });
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [r, a, b] }), shared)).toEqual({ favoriteModels: [r, a, b] });
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, b] }), prefs({ favoriteModels: [b] }), shared)).toEqual({ favoriteModels: [b] });
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
