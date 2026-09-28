import { expect, test } from "bun:test"

// openchamber#333 review 2, through the real draft store and a real Storage: the FIRST write of a draft fails on quota
// inside the composer's 500 ms debounce window (no earlier failure: the ephemeral flag is still false). A new-build
// reconnect must not reload it away; once storage has room, saving that exact text lets the reload go, and the new page
// restores it. The page's localStorage is installed before the draft store first reads it.
const backing = new Map<string, string>()
let quotaFull = true
const localStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (quotaFull) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
    backing.set(key, value)
  },
  removeItem: (key: string) => void backing.delete(key),
  clear: () => backing.clear(),
  key: (index: number) => [...backing.keys()][index] ?? null,
  get length() { return backing.size },
}
Object.assign(globalThis, { window: Object.assign(globalThis.window ?? {}, { localStorage }) })

test("a draft whose first save fails on quota holds the reload; saved now, the reload goes and restores it", async () => {
  const { claimChatDraftOwnership, createChatDraftIdentity, isChatDraftEphemeral, readChatDraft, writeChatDraft } =
    await import("./chatDraftPersistence")
  const { draftAtRisk, holdReload, reloadHeld, reloadIfNewBuild } = await import("./newBuildReload")
  const index = (entry: string) => `<script type="module" crossorigin src="${entry}"></script>`
  const reconnect = async () => {
    let reloaded = 0
    await reloadIfNewBuild({ running: () => "/assets/main-OLD.js", fetchIndex: async () => index("/assets/main-NEW.js"),
      busy: () => reloadHeld(), reload: () => { reloaded += 1 } })
    return reloaded
  }
  const identity = createChatDraftIdentity("runtime-333", "/repo", "session-333")!
  claimChatDraftOwnership(identity)
  const text = "a long pasted draft that does not fit"
  expect(isChatDraftEphemeral()).toBe(false) // No write failed yet: the old guard would have reloaded here.
  // ChatInput's check: save this exact text now through the draft store; only a success lets the reload go.
  const release = holdReload(() => draftAtRisk(text, true, () => writeChatDraft(identity, text, []) === true))
  expect(await reconnect()).toBe(0) // Held: saving it now failed on quota.
  quotaFull = false // Storage has room again.
  expect(await reconnect()).toBe(1) // Saved now: the reload may go,
  expect(backing.get("openchamber.chatDrafts.v2")).toContain(text) // durably, in the real Storage,
  expect(readChatDraft(identity).text).toBe(text) // and the new page restores exactly this text.
  release()
})

test("review 3: two editors share a draft slot; the other saved beta, so this one's alpha holds the reload and beta is kept", async () => {
  const { chatDraftDurablyHolds, claimChatDraftOwnership, createChatDraftIdentity, readChatDraft, writeChatDraft } =
    await import("./chatDraftPersistence")
  const { draftAtRisk } = await import("./newBuildReload")
  quotaFull = false
  const identity = createChatDraftIdentity("runtime-333", "/repo", "session-shared")!
  claimChatDraftOwnership(identity)
  expect(writeChatDraft(identity, "alpha", [])).toBe(true) // Tab A saved alpha; its write-skip cache now says alpha.
  // Tab B, the same session in another tab, saves beta into the same slot of the shared Storage.
  const envelope = JSON.parse(backing.get("openchamber.chatDrafts.v2")!)
  for (const draft of Object.values(envelope.drafts) as { text: string }[]) draft.text = "beta"
  backing.set("openchamber.chatDrafts.v2", JSON.stringify(envelope))
  // Tab A's reload check: its save would be skipped as unchanged, so only a read-back can tell.
  expect(chatDraftDurablyHolds(identity, "alpha")).toBe(false)
  expect(draftAtRisk("alpha", true, () => chatDraftDurablyHolds(identity, "alpha"))).toBe(true) // Held: alpha is kept.
  expect(readChatDraft(identity).text).toBe("beta") // And tab B's draft is not overwritten.
  expect(draftAtRisk("beta", true, () => chatDraftDurablyHolds(identity, "beta"))).toBe(false) // Counterexample.
})
