import { expect, test } from "bun:test"

// #278: a View only history replacement compares these revisions (session-message-loader.ts).
test("a session's event revision never returns to an earlier value, even after eviction", async () => {
  const { applyDirectoryEvent, sessionMessageEventCount } = await import("./event-reducer")
  const apply = (sessionID: string) => applyDirectoryEvent({ message: {}, part: {} } as never,
    { type: "message.removed", properties: { sessionID, messageID: "gone" } } as never)
  const before = sessionMessageEventCount("s-evicted")
  apply("s-evicted")
  for (let i = 0; i < 1100; i++) apply(`s-other-${i}`) // Evicts s-evicted's revision.
  expect(sessionMessageEventCount("s-evicted")).toBeGreaterThan(before)
})
