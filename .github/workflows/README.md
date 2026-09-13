# Owning PR checks

`oc-review.yml` is the existing disposable hosted check for the protected
`smarty-code` integration branch. It retains frozen installation, branding,
workspace builds, type checks, ESLint, changelog checks, isolated tests and
Electron checks. The `checks` job and protected Mergify queue remain mandatory.

## Reports and the independent landing gate

The Knip and Oxlint steps produce reports. A completed report is **not** a
lint-clean result, product acceptance, or permission to queue a pull request.
Knip's owning command deliberately uses `--no-exit-code`.

Oxlint uses the installed package through `scripts/anti-slop.mjs`. It runs once
over the complete tested PR merge's changed JS/TS files, not merely the last
contributor commit. Checkout depth two supplies the actual merge parents.
NUL-delimited paths and explicit argument terminators preserve file boundaries.
`--include-noisy` retains every configured rule, severity and finding. The log
contains the raw Oxlint exit code and full JSON report, plus readable findings.
A valid findings exit of one completes the report; missing/malformed reports,
inconsistent status, spawn failure, signals and abnormal exits fail the step.

Before making an exact head ready or submitting it to the `smarty-code` queue,
the integration owner must:

1. Bind actual run/attempt/job, tested merge, ordered parents and tree to that
   head. Inspect the complete Knip and Oxlint reports, including findings outside
   the edited lines of selected files.
2. Classify **every** finding against the owning base and relevant source context.
   Resolve every authored or unclassified finding. A matching line, aggregate
   count, prior green job or batch report is not an automatic exemption.
3. Obtain independent exact-head acceptance of the report/context disposition.
   Record source identities, report digests, inherited backlog, resolutions and
   limits in the PR. Review the disposition again when relevant source or reports
   change; do not transfer acceptance by branch name.
4. Receive all original required checks and protected speculative checks. Preserve
   failed runs and report skipped stages as NOT RUN. Never queue a red head.

This is a mandatory independent **process gate**, not an automatic no-new-findings
checker. It follows AGENTS: fix authored findings without mass-fixing inherited
backlog, disabling rules, reducing severity or laundering types. The maintenance
`next-batch`/`check-batch` commands and claims are not used for PR admission.

The report-path tests use isolated process fixtures; they do not prove a real
Oxlint invocation, compiler, browser or native runtime. Real changed-head hosted
execution and the independent disposition remain required after source changes.
