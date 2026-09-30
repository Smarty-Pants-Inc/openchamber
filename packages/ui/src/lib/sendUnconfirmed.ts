/**
 * smarty-code#827: how long a send to a Pi session may stay unanswered before its text comes back to the composer
 * (the POST may have stalled: under load it once never left the page). Tests shorten it.
 */
export const sendUnconfirmed = { ms: 15_000 };
