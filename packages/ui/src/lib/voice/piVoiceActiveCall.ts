import React from 'react';
import type { PiVoiceMedia, PiVoiceSocket, PiVoiceState } from './piVoiceCall';

// The page's one voice call, bound to the session where it started. Browsing other sessions
// neither moves nor ends it; moving it is the explicit movePiVoiceCallHere(). Leaving the page ends it.

export type PiVoiceCallState = { status: 'starting' } | PiVoiceState;
export type ActivePiVoiceCall = { sessionId: string; directory: string; state: PiVoiceCallState };
export type PiVoiceCallHooks = {
  /** Called with the reason when a started call ends on its own (not when the person ends or moves it). */
  onEnded(reason: string): void;
  /** Called when a call could not start; any previous call keeps running. */
  onFailed(reason: string): void;
};
/** How a call is made; injected by tests. */
export type PiVoiceCallDriver = {
  media(): PiVoiceMedia;
  load(): Promise<{
    beginPiVoiceCall(prepared: Promise<void>, media: PiVoiceMedia, openSocket: () => PiVoiceSocket,
      onState: (state: PiVoiceState) => void, wanted: () => boolean): Promise<{ hangup(): void } | undefined>;
    openPiVoiceSocket(sessionId: string, directory: string): PiVoiceSocket;
  }>;
};

let active: (ActivePiVoiceCall & { hangup?: () => void; generation: number }) | undefined;
let generation = 0, snapshot: ActivePiVoiceCall | undefined;
const listeners = new Set<() => void>();
const publish = () => {
  snapshot = active && { sessionId: active.sessionId, directory: active.directory, state: active.state };
  for (const listener of listeners) listener();
};

export function getActivePiVoiceCall() { return snapshot; }
export function subscribeActivePiVoiceCall(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useActivePiVoiceCall() {
  return React.useSyncExternalStore(subscribeActivePiVoiceCall, getActivePiVoiceCall, getActivePiVoiceCall);
}

/** Ends the page's call, including one still starting, and releases the microphone. */
export function endActivePiVoiceCall() {
  generation++; // Also cancels a start still preparing its microphone.
  const current = active;
  if (!current) return;
  active = undefined;
  current.hangup?.();
  publish();
}

/**
 * Starts a call on this session inside the person's click, or moves the page's call here. The new
 * microphone is prepared first; only when it is ready does the previous call end, so a denied
 * microphone leaves an existing call running.
 */
export async function startPiVoiceCallFor(sessionId: string, directory: string, driver: PiVoiceCallDriver, hooks: PiVoiceCallHooks) {
  if (active?.sessionId === sessionId && active.directory === directory) return;
  const media = driver.media(), prepared = media.prepare();
  const owner = ++generation;
  const previous = active;
  let voice: Awaited<ReturnType<PiVoiceCallDriver['load']>>;
  try {
    voice = await driver.load();
    await prepared;
  } catch (error) {
    void prepared.catch(() => undefined); media.close();
    if (generation === owner) generation++;
    hooks.onFailed(error instanceof Error ? error.message : String(error));
    return;
  }
  if (generation !== owner) { media.close(); return; } // Superseded by a newer start or an end.
  previous?.hangup?.(); // Ends the old session's call; its engine stops on its own.
  active = { sessionId, directory, state: { status: 'starting' }, generation: owner };
  publish();
  try {
    const call = await voice.beginPiVoiceCall(prepared, media, () => voice.openPiVoiceSocket(sessionId, directory), next => {
      if (active?.generation !== owner) return;
      if (next.status === 'ended') {
        active = undefined; publish();
        if (next.error) hooks.onEnded(next.error);
        return;
      }
      active.state = next; publish();
    }, () => active?.generation === owner);
    if (active?.generation === owner && call) active.hangup = () => call.hangup();
    else call?.hangup();
  } catch (error) {
    if (active?.generation === owner) { active = undefined; publish(); }
    hooks.onFailed(error instanceof Error ? error.message : String(error));
  }
}

/** Explicit move: the page's call ends on its session and starts on this one, in one click. */
export const movePiVoiceCallHere = startPiVoiceCallFor;

// A page that is unloaded (not merely backgrounded) ends its call. A page kept in the back/forward
// cache loses its socket, and the call then ends with a reason rather than silently.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', event => { if (!event.persisted) endActivePiVoiceCall(); });
}
