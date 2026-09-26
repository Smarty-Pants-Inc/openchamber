/**
 * Status objects that a send set optimistically, before the server said anything. A server status for the session
 * replaces one of these even when it is equal, so a send's rollback (which resets only its own object) never undoes
 * the server's word (co-steer review on openchamber#234).
 */
export const optimisticStatuses = new WeakSet<object>()
