/**
 * smarty-code#827: how long a send to a Pi session may stay unanswered before its text comes back to the composer
 * (the POST may have stalled: under load it once never left the page). Tests shorten it.
 *
 * smarty-code#1396: bounded from measured answers, not a guess. Over 7 days of gateway `smarty.prompt` logs on the
 * deployed service (2026-09-29..10-06, n 458, load to ~139 on 32 cores): p99 15.3 s, max 20.1 s. The old 15 s fired on
 * normal slow answers (6 of 458) and said "not confirmed" for delivered messages. ponytail: 45 s is above 2x the
 * measured max; a truly stalled POST still gives the text back well within a minute.
 */
export const sendUnconfirmed = { ms: 45_000 };
