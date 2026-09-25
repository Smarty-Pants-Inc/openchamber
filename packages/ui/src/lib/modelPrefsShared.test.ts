import { expect, test } from 'bun:test';
import { mergeExplicitChange, type ModelPrefs } from './modelPrefsShared';

const a = { providerID: 'p', modelID: 'a' }, b = { providerID: 'p', modelID: 'b' }, r = { providerID: 'q', modelID: 'restored' };
const prefs = (over: Partial<ModelPrefs> = {}): ModelPrefs => ({ favoriteModels: [], hiddenModels: [], collapsedModelProviders: [],
  recentModels: [], recentAgents: [], recentEfforts: {}, ...over });

test('a favourite toggle adds or removes only that model on the shared list; local-only entries stay local', () => {
  const shared = prefs({ favoriteModels: [a] });
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, r] }), prefs({ favoriteModels: [a, r, b] }), shared)).toEqual({ favoriteModels: [a, b] });
  expect(mergeExplicitChange(prefs({ favoriteModels: [a, r] }), prefs({ favoriteModels: [r] }), shared)).toEqual({ favoriteModels: [] });
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
