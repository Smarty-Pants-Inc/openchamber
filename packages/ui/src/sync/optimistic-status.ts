/**
 * Status objects that a send set optimistically, before the server said anything. A server status for the session
 * replaces one of these even when it is equal, so a send's rollback (which resets only its own object) never undoes
 * the server's word (co-steer review on openchamber#234).
 */
export const optimisticStatuses = new WeakSet<object>()

/**
 * smarty-code#827: the optimistic statuses whose send is still unanswered (its POST is in flight). Under load a prompt's
 * admission took 6-13 s, and an authoritative status snapshot read meanwhile said idle, so the page showed the session
 * idle while it was starting ("the agent finished first", turn-settled-locally). Such a snapshot does not lower these;
 * once the POST is answered the status is the server's to set again.
 */
export const sendingStatuses = new WeakSet<object>()
