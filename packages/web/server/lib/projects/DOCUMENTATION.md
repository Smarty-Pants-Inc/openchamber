# Projects

## Purpose

Server-owned storage for a project's per-user config file,
`~/.config/openchamber/projects/<projectId>.json`. The file holds two
families of keys with different writers, and this module is the only place
that writes it:

| Keys | Owner | Reached through |
|---|---|---|
| `version`, `scheduledTasks` | `project-config.js` (scheduled-task runtime) | `/api/projects/:projectId/scheduled-tasks/*` |
| `setup-worktree`, `setup-worktree-wait`, `projectActions`, `projectActionsPrimaryId`, `draftStarters`, `projectPath` | `project-setup.js` via `readProjectSetup` / `updateProjectSetup` on the same runtime | `GET/PUT /api/projects/:projectId/config` (`routes.js`) |

Notes, todos, and plans moved out of this file to `packages/web/server/lib/project-context`.

### Repository shared config is disabled

Repository shared config, including shared command/action and draft-starter
discovery, is hard-disabled under
[smarty-code#1325, item 3](https://github.com/Smarty-Pants-Inc/smarty-code/issues/1325).
Upstream commit `82a0ee7572e59dbc965d593268a41ef0395860fa` introduced the shared
reader/writers. Their pathname IO followed repository-controlled links. Node
cannot portably bind directory creation, rename and removal to checkout custody.
The fork disables this unused feature instead of adding a check-then-write guard.

`GET /api/projects/:projectId/config` reads only personal storage. Its `shared`
block is explicitly `status: "invalid", reason: "shared-project-config-disabled"`,
with empty shared lists and `plansDir: null`. This is an unavailable feature,
not an authoritative claim that a repository file is missing or empty. The
existing `shared.path` is the relative contract name `.openchamber/project.json`,
never a decoded or canonical checkout path. Top-level commands, actions and
starters come only from the personal file; actions/starters carry `source: "personal"`.

`updateSharedProjectSetup` and the VS Code store's `updateShared` reject with
`shared-project-config-writes-disabled` before locks, write chains, personal
reads or checkout IO. The existing web route returns 500 JSON with that error;
the native bridge returns `success: false` with the same error, and its webview
maps the failure to 500. The shared UI write client returns `null` on failure.
Metadata, command/starter sharing, no-op patches and empty-config removal all
refuse, even for an ordinary checkout or an absent target parent.

No platform, preference, environment variable or repository value may opt in.
Shared files, directories and personal trust records are not deleted, migrated,
repaired or reset. Personal config, actions, tasks and unknown keys still use
ordinary locked read-modify-write storage. Dormant shared parsers/merge utilities
remain for format tests; they are not an enabled discovery or mutation path.

### Trust

Shared config is undiscovered, so production views have
`trust: { hash: null, trusted: true }` because no shared executable set is
available. This does not mint or change an approval. Existing personal
`sharedTrust` records and their timestamps survive reads and refused shared
writes unchanged. The explicit personal `sharedTrustHash` write remains
supported; `null` forgets that record. Personal actions and setup remain usable.

The dormant format hash/merge contract still hashes the complete executable set,
including action `runIn`. Existing stored records cannot distinguish explicit
approvals from approvals minted by older shared writers. This repair does not
reset or migrate them, and re-enabling repository discovery would require a new
security review and an approval-provenance decision.

### Repository shared plans are disabled

`resolveSharedPlansDir` always returns `null`, before reading personal config or
checkout metadata. There is no opt-in through preferences, environment variables,
or `plansDir`. Repository shared plans are unused in Smarty Code, and upstream
commit `82a0ee7572e59dbc965d593268a41ef0395860fa` introduced shared-plan filesystem
operations that follow escaping symlinks. The fork decision and follow-up are
tracked in [smarty-code#1325](https://github.com/Smarty-Pants-Inc/smarty-code/issues/1325).
Stored repository files and shared manifest entries are retained, not migrated or
deleted. Personal plans, notes and todos remain owned by project-context.

## Modules

- `project-id.js` — `createProjectIdFromPath` / `projectPathFromId`: the path-derived id (`path_<base64url>`) that names the file, and the checkout path back from it. The shared UI derives the same id (`packages/ui/src/lib/projectId.ts`); both sides must agree. `projectConfigFileStemOf`: the stem that names the file and the sibling folder for an id, see the file name invariant below.
- `project-config.js` — `createProjectConfigRuntime`: raw read, atomic write, the cross-process file lock (Electron and a CLI `serve` can share one projects dir), scheduled-task normalization, and the project-setup read/update.
- `project-setup.js` — sanitizers, the dormant shared-file parser (`parseSharedProjectConfig`, `normalizePlansDir`), the merge (`mergeProjectSetup`, supplied only a disabled shared result in production), and the personal view for the setup keys. Mirrored in the VS Code extension host (`packages/vscode/src/project-setup.ts`), which owns the same file when the webview has no OpenChamber server; keep the two in sync.
- `routes.js` — the setup routes. `/api/projects` is on the JSON-body allowlist in `opencode/core-routes.js`.

## Invariants

- **Every write is a locked read-modify-write of the whole document.** Keys the writer does not own, and keys from newer builds, come back out unchanged. A setup update and a scheduled-task update never clobber each other.
- **A wrongly shaped key is a 400, not a silent drop.** `projectSetupPatchToStored` throws; the file is untouched. Values inside a well-shaped key are sanitized (trimmed, capped, deduplicated) rather than rejected.
- **The file name is bounded, and so is the folder beside it.** The file is `<projectId>.json` and the per-project folder is `<projectId>/` while the id is at most 200 characters. A `path_<base64url>` id grows with the checkout path, so a deeply nested project (a path of roughly 150 characters or more) would otherwise get a name beyond the 255-byte limit and every write, lock, and temp file would fail with ENAMETOOLONG. Such an id is stored as `path_sha256_<hex digest of the id>.json` instead, with the folder `path_sha256_<digest>/` beside it (`projectConfigFileStemOf`; every composer of either path goes through it: `project-config.js`, `project-context/runtime.js`, `agent-memory/runtime.js`, and the id migration and orphan recovery in `opencode/settings-runtime.js`). The digest keeps the `path_` prefix so orphan recovery skips it. A file an older build managed to write under the long name is still read when the bounded file is missing and is moved to the bounded name by the next write; a malformed one is a read failure, not an empty project. A folder an older build created under the raw id (possible only for ids of 201 to 255 characters; longer names never got one) is moved into the bounded folder once at startup, by the project id migration in `opencode/settings-runtime.js`, with `context.json` merged by entry identity when both exist. The VS Code extension host mirrors both the naming rule and the legacy read-then-move for the file (`bridge-project-setup-runtime.ts`), because a VS Code-only user has no server to do it; it never touches the folder.
- **The client never composes the path.** `packages/ui/src/lib/openchamberConfig.ts` speaks only HTTP; the same code serves web, desktop, VS Code, and the phone, including a phone on a remote instance.
- **`OPENCHAMBER_DATA_DIR` moves this directory too.** Every OpenChamber folder hangs off the one root; a custom root gets `projects/`, `themes/`, and `speech-models/` copied in from `~/.config/openchamber` once at startup (copied, not moved: a second instance beside the default one must not strip it) (`lib/data-dir-migration.js`). A scratch server started with its own data dir therefore never touches the real project configs.
