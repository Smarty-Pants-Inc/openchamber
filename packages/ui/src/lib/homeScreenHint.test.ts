import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { HOME_SCREEN_HINT_KEY, dismissHomeScreenHint, readHomeScreenHintEnv, shouldShowHomeScreenHint, type HomeScreenHintEnv } from './homeScreenHint';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1';
const IOS_WEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const env = (over: Partial<HomeScreenHintEnv>): HomeScreenHintEnv =>
  ({ userAgent: IPHONE, maxTouchPoints: 5, standalone: false, displayModeStandalone: false, dismissed: false, ...over });

test('shown on iPhone and iPad Safari in the browser', () => {
  expect(shouldShowHomeScreenHint(env({}))).toBe(true);
  expect(shouldShowHomeScreenHint(env({ userAgent: IPAD }))).toBe(true);
});

test('never in the installed app', () => {
  expect(shouldShowHomeScreenHint(env({ standalone: true }))).toBe(false);
  expect(shouldShowHomeScreenHint(env({ standalone: undefined, displayModeStandalone: true }))).toBe(false);
});

test('never on desktop, Android, other iOS browsers or the native shell', () => {
  expect(shouldShowHomeScreenHint(env({ userAgent: IPAD, maxTouchPoints: 0 }))).toBe(false); // desktop Mac Safari
  expect(shouldShowHomeScreenHint(env({ userAgent: ANDROID }))).toBe(false);
  expect(shouldShowHomeScreenHint(env({ userAgent: IOS_CHROME }))).toBe(false);
  expect(shouldShowHomeScreenHint(env({ userAgent: IOS_WEBVIEW }))).toBe(false);
});

test('dismissal is remembered in localStorage', async () => {
  const win = new Window({ url: 'https://code.example.test/' });
  Object.defineProperty(win.navigator, 'userAgent', { value: IPHONE });
  Object.defineProperty(win.navigator, 'maxTouchPoints', { value: 5 });
  const w = win as unknown as globalThis.Window;
  expect(shouldShowHomeScreenHint(readHomeScreenHintEnv(w))).toBe(true);
  dismissHomeScreenHint(w);
  expect(win.localStorage.getItem(HOME_SCREEN_HINT_KEY)).toBe('1');
  expect(shouldShowHomeScreenHint(readHomeScreenHintEnv(w))).toBe(false);
  await win.happyDOM.close();
});
