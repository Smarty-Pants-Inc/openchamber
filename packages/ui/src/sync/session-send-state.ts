export type SessionSendFailure = 'refused' | 'unknown';

export type SessionSendAttempt = {
  readonly messageID: string;
  canDispatch(): boolean;
  /** Called only by the SDK's final preparation gate, not optimistic insertion. */
  dispatched(): void;
  accepted(): void;
  failed(outcome: SessionSendFailure): void;
};
type Reservation = { messageID: string; phase: 'preparing' | 'dispatched' | 'unknown' };

// Browser-lifetime authority. Neither provider replacement nor editor teardown clears
// a reservation. Directory is routing, not admission identity. There is no replay,
// watchdog, eviction, persistence or cross-tab guarantee here.
const runtimes = new Map<string, Map<string, Reservation>>();

export const sessionSendState = {
  isPending(runtimeKey: string, sessionId: string): boolean {
    return runtimes.get(runtimeKey)?.has(sessionId) ?? false;
  },
  begin(runtimeKey: string, sessionId: string, messageID: string): SessionSendAttempt | null {
    let sessions = runtimes.get(runtimeKey);
    if (sessions?.has(sessionId)) return null;
    if (!sessions) { sessions = new Map(); runtimes.set(runtimeKey, sessions); }
    const reservation: Reservation = { messageID, phase: 'preparing' };
    sessions.set(sessionId, reservation);
    const owner = sessions;
    const owns = () => runtimes.get(runtimeKey)?.get(sessionId) === reservation;
    const release = () => {
      if (!owns()) return;
      owner.delete(sessionId);
      if (!owner.size) runtimes.delete(runtimeKey);
    };
    return {
      messageID,
      canDispatch: () => owns() && reservation.phase !== 'unknown',
      dispatched: () => { if (owns() && reservation.phase === 'preparing') reservation.phase = 'dispatched'; },
      accepted: release,
      failed: outcome => {
        if (!owns() || reservation.phase === 'unknown') return;
        if (reservation.phase === 'dispatched' && outcome === 'unknown') reservation.phase = 'unknown';
        else release();
      },
    };
  },
};
