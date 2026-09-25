import React from 'react';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { PiVoiceMedia, PiVoiceSocket, PiVoiceState } from './piVoiceCall';

// The page's one voice call, bound to the session AND the Code runtime (instance) where it started.
// Browsing other sessions neither moves nor ends it; moving it is an explicit start on another
// session. Switching runtime ends it, and aborts one still starting: a call never connects through
// a runtime other than its own. Leaving the page ends it.

export const RUNTIME_CHANGED = 'You switched to another Code instance.';

type PiVoiceCallState = { status: 'starting' } | PiVoiceState;
type ActivePiVoiceCall = { runtimeKey: string; sessionId: string; directory: string; state: PiVoiceCallState };
/** The runtime a call belongs to: its key, and whether it is still the page's current runtime. */
export type PiVoiceRuntimeScope = { key: string; current(): boolean };
export type PiVoiceCallHooks = {
  /** Called with the reason when a started call ends on its own (not when the person ends or moves it). */
  onEnded(reason: string): void;
  /** Called when a call could not start; any previous call keeps running. */
  onFailed(reason: string): void;
};
/** How a call is made; injected by tests. */
export type PiVoiceCallDriver = {
  /** Captured in the click, before any await. */
  scope(): PiVoiceRuntimeScope;
  media(): PiVoiceMedia;
  load(): Promise<{
    beginPiVoiceCall(prepared: Promise<void>, media: PiVoiceMedia, openSocket: () => PiVoiceSocket,
      onState: (state: PiVoiceState) => void, wanted: () => boolean): Promise<{ hangup(): void } | undefined>;
    openPiVoiceSocket(sessionId: string, directory: string): PiVoiceSocket;
  }>;
};

let active: (ActivePiVoiceCall & { hangup?: () => void; generation: number; hooks: PiVoiceCallHooks }) | undefined;
let generation = 0, snapshot: ActivePiVoiceCall | undefined;
const listeners = new Set<() => void>();
const publish = () => {
  snapshot = active && { runtimeKey: active.runtimeKey, sessionId: active.sessionId, directory: active.directory, state: active.state };
  for (const listener of listeners) listener();
};

export function getActivePiVoiceCall() { return snapshot; }
function subscribeActivePiVoiceCall(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useActivePiVoiceCall() {
  return React.useSyncExternalStore(subscribeActivePiVoiceCall, getActivePiVoiceCall, getActivePiVoiceCall);
}

/** Ends the page's call, including one still starting, and releases the microphone. A reason is told to the person. */
export function endActivePiVoiceCall(reason?: string) {
  generation++; // Also cancels a start still preparing its microphone.
  const current = active;
  if (!current) return;
  active = undefined;
  current.hangup?.();
  publish();
  if (reason) current.hooks.onEnded(reason);
}

/** Any runtime change: the call and a start still preparing both end; neither reaches the new runtime. */
export const endPiVoiceCallForRuntimeChange = () => endActivePiVoiceCall(RUNTIME_CHANGED);

/**
 * Starts a call on this session inside the person's click, or moves the page's call here. The new
 * microphone is prepared first; only when it is ready does the previous call end, so a denied
 * microphone leaves an existing call running.
 */
export async function startPiVoiceCallFor(sessionId: string, directory: string, driver: PiVoiceCallDriver, hooks: PiVoiceCallHooks) {
  const scope = driver.scope();
  if (active?.runtimeKey === scope.key && active.sessionId === sessionId && active.directory === directory) return;
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
  if (!scope.current()) { // The runtime changed while the microphone or module was loading.
    media.close();
    if (generation === owner) generation++;
    hooks.onFailed(RUNTIME_CHANGED);
    return;
  }
  if (generation !== owner) { media.close(); return; } // Superseded by a newer start or an end.
  previous?.hangup?.(); // Ends the old session's call; its engine stops on its own.
  active = { runtimeKey: scope.key, sessionId, directory, state: { status: 'starting' }, generation: owner, hooks };
  publish();
  try {
    // The socket opens only through the runtime the call started in.
    const open = () => { if (!scope.current()) throw new Error(RUNTIME_CHANGED); return voice.openPiVoiceSocket(sessionId, directory); };
    const call = await voice.beginPiVoiceCall(prepared, media, open, next => {
      if (active?.generation !== owner) return;
      if (next.status === 'ended') {
        active = undefined; publish();
        if (next.error) hooks.onEnded(next.error);
        return;
      }
      active.state = next; publish();
    }, () => active?.generation === owner && scope.current());
    if (active?.generation === owner && call) active.hangup = () => call.hangup();
    else call?.hangup();
  } catch (error) {
    if (active?.generation === owner) { active = undefined; publish(); }
    hooks.onFailed(error instanceof Error ? error.message : String(error));
  }
}


// A page that is unloaded (not merely backgrounded) ends its call. A page kept in the back/forward
// cache loses its socket, and the call then ends with a reason rather than silently.
globalThis.window?.addEventListener('pagehide', event => { if (!event.persisted) endActivePiVoiceCall(); });
// Instance switching (mobile, desktop) happens in the page: it ends the call before the endpoint moves.
subscribeRuntimeEndpointWillChange(endPiVoiceCallForRuntimeChange);
subscribeRuntimeEndpointChanged(endPiVoiceCallForRuntimeChange);
