/**
 * smarty-code#1427: the event pipeline connected again, or switched transport. Transport can recover with no change in
 * connection state; listeners (the selected-owner recovery) treat this as a recovery signal. It carries no data.
 */
const listeners = new Set<() => void>();
export function subscribeTransportReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyTransportReady(): void {
  for (const listener of [...listeners]) listener();
}
