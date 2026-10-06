# CLI Module Map

This directory contains the non-entrypoint implementation for the OpenChamber CLI. `packages/web/bin/cli.js` should stay thin: it owns bootstrap, command wiring, top-level dispatch, signal/cancel handling, and compatibility exports. Domain logic belongs in these modules.

## Entrypoint Boundary

- `../cli.js`
  - Owns process bootstrap, package/version lookup, command table wiring, signal handlers, top-level error handling, and legacy exports used by tests or external consumers.
  - Injects runtime dependencies into command factories, such as `serveCommand`, cancel cleanup, and foreground server state setters.
  - Should not grow command-specific behavior. If a new branch needs more than dispatch/wiring, move it here into a command or helper module instead.

## Command Modules

Command modules implement user-facing commands and preserve output contracts across interactive, non-TTY, `--quiet`, and `--json` modes. They should use `../cli-output.js` for presentation helpers and keep safety validation in command logic, not prompts.

- `commands-serve.js`
  - Implements `openchamber serve`.
  - Owns OpenCode CLI checks, port resolution, log rotation, PID/instance registry writes, foreground/background server launch, startup summaries, and foreground shutdown behavior.

- `commands-lifecycle.js`
  - Implements `openchamber stop` and `openchamber restart`.
  - Owns lifecycle stop/restart semantics, desktop-managed port rejection, PID/instance cleanup, and restart reuse of stored instance options. Instances are stopped by signal: the server has no HTTP shutdown route (smarty-code#1398), so an unmanaged instance is stopped through the pid its `/api/system/info` reports.

- `commands-status.js`
  - Implements `openchamber status`.
  - Formats discovered instances for human, quiet, and JSON output.

- `commands-session.js`
  - Implements `openchamber session create`, `send`, `fork`, `list`, `status`, and `messages`.
  - Maps CLI options to shared control-service inputs and owns only human, quiet, and JSON presentation.
  - Message projection matches Export Markdown semantics: only ordered `text` parts are exposed; tool, reasoning, file, and other parts are omitted.
  - The server control service owns create/worktree/prompt orchestration, official OpenCode reads, Goal Mode, wait semantics, and partial failures.

- `commands-schedule.js`
  - Implements scheduled task status/list/create/run/delete/enable/disable.
  - Maps options to control-service inputs and renders results; project resolution, validation, persistence, and execution remain server-owned.

- `commands-models.js`
  - Prints OpenChamber default, favorite, and recent model settings.

- `commands-projects.js`
  - Prints configured project labels, ids, and directories for later control-plane calls.

- `commands-logs.js`
  - Implements `openchamber logs`.
  - Resolves log files, tails recent lines, and follows log output.

- `commands-startup.js`
  - Implements `openchamber startup`.
  - Handles startup subcommand dispatch and presentation around the lower-level startup service helpers.

- `commands-connect-url.js`
  - Implements `openchamber connect-url`.
  - Finds or starts a local instance and prints the browser/connect URL according to the selected output mode.
  - Emits a **pairing v2** link (`openchamber://connect?v=2&p=<base64url>`): it creates a one-time pairing session in the shared store (`client-pairing-sessions.json`) and encodes the pairing id + secret + transport candidates. The client redeems the secret over whichever candidate connects first (`/api/client-auth/pairing/redeem`). No standalone token is embedded — the QR itself is the single-use credential.
  - Advertises the resolved server URL as the single direct (lan/tunnel) candidate. The server hosts no relay, so links carry no relay candidate.
  - There is no `openchamber update` or `openchamber tunnel` command: both called server routes that were removed (smarty-code#1398).

## Shared Helper Modules

These modules hold reusable, non-presentational logic for commands.

- `cli-args.js`
  - Argument parsing, defaults, help text, and typo suggestions.

- `cli-errors.js`
  - CLI exit codes and the typed CLI error (`TunnelCliError`, a legacy name).

- `cli-paths.js`
  - Data, run, log, and settings paths.

- `cli-process.js`
  - PID files, instance registry files, process identity checks, runtime metadata checks, and process termination helpers.

- `cli-lifecycle.js`
  - Instance discovery, live health probing, and status aggregation used by lifecycle/status commands.

- `cli-http.js`
  - HTTP helpers for health checks, JSON API calls, and system info fetches.
  - Owns local desktop bearer auth and managed CLI-instance UI password retry for control-plane requests.

- `cli-control.js`
  - Sends one typed action request to the authenticated OpenChamber control endpoint and maps HTTP failures to CLI exit behavior.
  - Must not reproduce session, scheduled-task, project-resolution, or wait orchestration.

- `cli-api-target.js`
  - Resolves the target OpenChamber runtime for control-plane commands, preferring desktop unless a port is explicit.

- `cli-goal.js`
  - Owns shared Goal Mode token-budget validation for session and schedule commands.

- `cli-network.js`
  - Host resolution, URL building, LAN detection, unsafe browser port validation, and UI password/network exposure checks.

- `cli-ports.js`
  - Port availability checks and available-port resolution.

- `cli-log-files.js`
  - Log rotation, tail reads, and file-follow streaming.

- `cli-executables.js`
  - Executable path resolution and PATH lookup helpers.

- `cli-startup.js`
  - Native startup service detection, install/uninstall/status helpers, and platform-specific startup command execution.

## Placement Rules

- Add new CLI commands as `commands-*.js` modules and wire them from `cli.js`.
- Add reusable logic to the narrow helper module that owns the domain. Create a new helper module before mixing unrelated domains into an existing one.
- Keep command modules responsible for user-visible behavior and mode-specific output. Keep helper modules mostly output-free unless the helper exists specifically for CLI rendering.
- Preserve output contracts when moving code:
  - `--json` emits JSON only.
  - `--quiet` emits concise essential output.
  - Prompts are gated by `canPrompt(options)`.
  - Validation and policy run in every mode.
- Prefer dependency injection from `cli.js` for cross-command behavior, especially when one command needs another command's implementation.
- Do not import `cli.js` from modules in this directory. The dependency direction is `cli.js` -> command modules -> helper modules.

## Verification

For CLI behavior changes, run the focused CLI suite from `packages/web`:

```sh
bun run test -- bin/cli.test.js
```

Before finalizing source changes that affect CLI behavior, also run:

```sh
bun run type-check
bun run lint
```
