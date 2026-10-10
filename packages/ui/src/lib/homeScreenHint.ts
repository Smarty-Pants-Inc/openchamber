// smarty-code#1489: a one-time line on iOS Safari, when Smarty Code is not installed, saying how to add it to the
// Home Screen. Never in the installed app (standalone), on a desktop, on Android or in another iOS browser.
export const HOME_SCREEN_HINT_KEY = 'smarty.homeScreenHint.dismissed';

export type HomeScreenHintEnv = {
  userAgent: string;
  maxTouchPoints: number;
  /** iOS's navigator.standalone: true only in a home-screen app. */
  standalone?: boolean;
  displayModeStandalone: boolean;
  dismissed: boolean;
};

const OTHER_IOS_BROWSERS = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//;

/** iPhone, iPod, or iPad (iPadOS reports a Mac with touch); Safari only, not the native shell's WebView. */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && /Safari\//.test(userAgent) && !OTHER_IOS_BROWSERS.test(userAgent);
}

export function shouldShowHomeScreenHint(env: HomeScreenHintEnv): boolean {
  return !env.dismissed && env.standalone !== true && !env.displayModeStandalone
    && isIosSafari(env.userAgent, env.maxTouchPoints);
}

export function readHomeScreenHintEnv(win: Window = window): HomeScreenHintEnv {
  let dismissed = false;
  try { dismissed = win.localStorage.getItem(HOME_SCREEN_HINT_KEY) === '1'; } catch { dismissed = true; }
  return {
    userAgent: win.navigator.userAgent,
    maxTouchPoints: win.navigator.maxTouchPoints || 0,
    standalone: (win.navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone: typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches,
    dismissed,
  };
}

export function dismissHomeScreenHint(win: Window = window): void {
  try { win.localStorage.setItem(HOME_SCREEN_HINT_KEY, '1'); } catch { /* private mode: hidden for this page only */ }
}
