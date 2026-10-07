import { create } from 'zustand';
import { z } from 'zod';
import type { SessionStatus as SDKSessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

// Smarty Code (smarty-code#539): a managed gateway's fleet-wide `/session/status?unknown=1` lists the projects whose own
// status read failed under `smarty.unknown`. Their sessions are absent from the map, which is NOT idle: the page keeps
// their last status for at most one poll, then clears busy/retry and says "Status unavailable". A stock server never
// sends the marker, so this set stays empty there.

export const STATUS_UNKNOWN_KEY = 'smarty.unknown';

type State = { directories: ReadonlySet<string> };
export const useStatusUnavailableStore = create<State>(() => ({ directories: new Set<string>() }));

const key = (directory: string): string => normalizeProjectPath(directory) ?? directory;

const markerSchema = z.array(z.object({ directory: z.string().min(1), status: z.number() }));

/** Removes the marker from a fleet map (in place) and returns its directories; an invalid marker counts as none. */
export const takeStatusUnknownDirectories = (map: Record<string, SDKSessionStatus>): string[] => {
  const marker = markerSchema.safeParse(map[STATUS_UNKNOWN_KEY]);
  delete map[STATUS_UNKNOWN_KEY];
  return marker.success ? marker.data.map((entry) => entry.directory) : [];
};

// Directories the watchdog has already seen unknown at one poll: the next poll that still finds them unknown clears them.
const heldOnce = new Set<string>();
let runtimeSubscribed = false;

const ensureRuntimeSubscription = (): void => {
  if (runtimeSubscribed || !globalThis.window) return;
  runtimeSubscribed = true;
  subscribeRuntimeEndpointChanged(() => recordStatusUnavailable([]));
};

/** Replaces the set wholesale: a directory is unknown only while the latest successful fleet read says so. */
export const recordStatusUnavailable = (directories: Iterable<string>): void => {
  ensureRuntimeSubscription();
  const next = new Set([...directories].map(key));
  for (const directory of heldOnce) if (!next.has(directory)) heldOnce.delete(directory);
  const current = useStatusUnavailableStore.getState().directories;
  if (next.size === current.size && [...next].every((directory) => current.has(directory))) return;
  useStatusUnavailableStore.setState({ directories: next });
};

export const isStatusUnavailable = (directory: string | null | undefined): boolean => (
  directory ? useStatusUnavailableStore.getState().directories.has(key(directory)) : false
);

/**
 * One watchdog poll of an unknown directory. False on the first: its last status is kept. True on each later poll that
 * still finds it unknown: the caller clears its busy/retry.
 */
export const noteStatusUnavailablePoll = (directory: string): boolean => {
  const normalized = key(directory);
  if (heldOnce.has(normalized)) return true;
  heldOnce.add(normalized);
  return false;
};

export const useStatusUnavailable = (directory: string | null | undefined): boolean => (
  useStatusUnavailableStore((state) => (directory ? state.directories.has(key(directory)) : false))
);
