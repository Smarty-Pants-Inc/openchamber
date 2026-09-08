# Smarty Code branding port

<!-- upstream-attribution:start -->
**Thank you, [OpenChamber](https://github.com/openchamber/openchamber), its
maintainers and contributors.** This fork preserves their application and
credits. Smarty Code's Pi integration lives in a separate repository; these
changes do not replace OpenChamber's backend or native platform behavior.
<!-- upstream-attribution:end -->

## Source and coverage authority

- Exact stock base: `2dfd1190eba8853c766c29ae27f09aeacc86bdb9` (1.22.2).
- Committed donor: `d6ef11b464bd33ea892419df5f7fbf668fa41896` in
  `Smarty-Pants-Inc/openchamber`; no active donor working state was copied.
- Replay sources: branding merge `af19b69b` (original seam `9991154d`) and
  sweep `e76c9aef`, relative to their first parents. Full IDs are in
  [`coverage.json`](coverage.json). Donor Pi/OMP/Codex/session-bridge behavior
  is **not** a source dependency and was not imported.
- The two source diffs cover **770 distinct files**. The generated ledger
  indexes each original textual hunk or binary-file change, its source-patch
  digest, output digest and disposition. A final-donor `git grep` finds no
  additional `Smarty Code`, `smarty-code`, or generated-brand consumer outside
  that union. This is a coverage cross-check, not proof of behavior parity.
- Explicit absent-owner decisions are in
  [`absent-owners.md`](absent-owners.md); every deletion-confirmation and
  paginated-history hunk has its own row. Applicable neighboring hunks remain
  ported. Existing neutral stock UI deletion/pagination errors stay unchanged.

## Small identity/assets boundary

`brand.json`, `logo.svg` and `symbol-template.svg` are the inputs.
`scripts/apply-brand.mjs` is a hardened **build-time generator**, not an upstream plugin or universal
white-label framework. Its five small generated modules expose shared product
identity/owned-template formatting to UI, server/CLI, Electron, VS Code and
mobile. Build-time HTML/JSON/XML/plist/Swift/Markdown/shell edits and platform
assets are generated from the same inputs.

```sh
bun run brand
bun run brand:check
bun run test:brand
# Requires the committed donor objects, not a donor working tree:
node scripts/inventory-branding-port.mjs
```

`generated.json` controls **142 outputs**: 5 modules, 27 patched text files,
12 SVG variants and 98 PNG variants. The donor's 140 outputs are all retained;
the two additions are current upstream Turkish VS Code manifest/runtime
localizations. `asset-parity.json` enumerates the original 98 raster paths and
dimensions. Native icon catalogs, Android density variants, iOS app icons,
widget assets, PWA maskable icons and light/dark logos are not collapsed into
one generic favicon.

The widget SVG keeps the stock SF Symbols Notes, Guides, SwiftDraw attribution
and Ultralight-S, Regular-S and Black-S glyph identities. The generator places
the configured monochrome artwork inside each glyph at the stock 70-unit cap
height. It does not write a generic SVG at the symbolset root. Changing this
artwork requires Apple asset compiler proof, not just an SVG or raster check.

The donor intentionally retired ten old artwork/build-helper paths: Electron's
Icon Composer glyphs/metadata, `Assets.car`, stock ICNS/ICO and their two helper
scripts; Android's single notification vector; VS Code's JPEG. The ledger names
each replacement: electron-builder's mac/win/linux icon fields consume generated
`app-icon.png`, Android keeps the `ic_stat_notify` resource via density PNGs,
and VS Code's manifest consumes `assets/app-icon.png`. These are demonstrated source
and generated-artifact equivalents, **not** installed-platform icon proof.

Existing build scripts invoke branding before building. Documentation branding
is separately checkable and included in `brand`/`brand:check`. Generation is
idempotent, detects missing/drifted controlled outputs and rejects malformed
configuration. Hostile-input tests cover HTML, Markdown/MDX, YAML, JSON,
TypeScript/Capacitor, shell percent/backslash and placeholder escaping.

## Presentation ownership, not content rewriting

- `brandText` accepts **owned templates only**, before interpolation. It is
  never a generic renderer for provider errors, tool output, user/project or
  session names, model messages, paths, IDs or imported source content.
- UI i18n uses `brandProductText` plus explicit external-artifact exceptions,
  then applies parameters. French elisions are repaired in owned copy, not
  arbitrary values. Current French and Turkish translations remain present.
- VS Code brands owned localized templates before `vscode.l10n.t` interpolates
  positional arguments. Current upstream localization APIs and Turkish keys
  are retained, including placeholder-parity checks.
- Generic toast and CLI output adapters stay byte-identical to stock. Caller
  modules brand their own templates. Raw errors/objects and existing diagnostic
  serialization remain untouched; the donor test expecting different Error
  normalization is adapted to the actual stock behavior, not used to justify
  a behavior patch.
- Markdown branding uses the existing editor parser to preserve link destinations,
  reference IDs, explicit upstream-attribution blocks and code. Owned link labels
  and titles still change. Collapsed and shortcut links retain their original
  reference through an explicit ID when the displayed label changes. HTML URL
  attributes and URLs in JSON/YAML documentation remain data. The documentation
  alias boundary excludes actual OpenCode identity. French product elisions and
  current upstream docs/frontmatter remain present.
- Four owned magic-prompt product references use `PRODUCT_NAME`. A whole-file
  normalized SHA-256 test proves the remaining prompt text is exact stock:
  no tool names, engine instructions, role semantics or provider/user prompts
  were changed.

## Full-surface reconciliation

| Surface | Retained coverage / current-stock adaptation |
| --- | --- |
| Web/shared UI | HTML titles/meta/loading mark, app/window title, auth, About, Settings, notifications, toasts, session/sidebar labels, support text, theme presentation, magic prompts and i18n. |
| CLI/installer | Owned help/banner/version/status/start/stop/update/doctor/tunnel/settings prompts and errors; shell installer headings. Real `openchamber`/`opencode` commands and arbitrary diagnostics stay unchanged. |
| Documentation | Root README, web/desktop/mobile/VS Code READMEs and current multilingual docs; prominent upstream gratitude, credits and truthful upstream-release instructions. Includes newer Turkish documents. |
| Electron | App/window/menu/dialog/title presentation, desktop/autostart/update artifact expectations and all icon variants. Upstream author is preserved. Legacy user-data/log paths, app ID, protocol, binary names, Linux WM class and update/release IDs remain compatible. No native backend substitution. |
| VS Code | Product and command categories, descriptions, view/connection/error titles, webview localized headings and icon. Three newer inline-comment categories use `%product.name%`; controller author comes from existing localized strings. Actual manager output channel is branded in stock `opencode.ts`, not recreated at the removed donor location. Commands/configuration/publisher/extension IDs stay unchanged. |
| Mobile/widgets | Capacitor/native display names, iOS/Android/web assets, light/dark and widget presentations, widget labels/extension descriptions; application/bundle IDs, app groups, URL schemes and server/session semantics remain unchanged. |
| Server | Owned startup/log/auth/PWA/callback/fallback labels only; existing escaped HTML boundaries, raw upstream error bodies, response codes, data shapes and control flow preserved. |

Upstream license hash and authorship are tested. Theme authors are not renamed;
product theme names/descriptions may be. Stock package versions/dependencies,
external artifact URLs and executable installation instructions remain truthful.

## Current upstream direction and proof boundary

The comparison also inspected upstream
`1090d8470742e91a46a946352b90e588aa98682f`, 33 commits beyond the adopted base.
No upstream pin advance is included. Current stock localization, output-channel,
PWA and platform APIs are preferred over donor-local replacements; there was no
adopted upstream identity hook covering these five packaging/runtime surfaces.
The narrow generator therefore remains the equivalent supported boundary.

See the integration repository's `docs/branding-proof.md` for exact commands,
measured results, browser evidence and limitations. Runtime web/CLI/native Pi
verification is distinguished there from native-shell unit tests, bundle
compilation and static/generated icon/manifest checks. Those checks **do not**
claim a launched Electron, VS Code extension host, installed mobile app, widget,
OS installer or PWA installation.

## Review corrections and Apple compiler gate

Independent review of `fa6942b2db97940b4a5801512491fb50de8e1c4b` found an invalid
widget symbol catalog and a rewritten integration repository URL. The generator
now keeps the native symbol template and protects technical documentation links.
The owning README again points to `https://github.com/Smarty-Pants-Inc/smarty-code`.
Focused regressions use the committed alias set, including `smarty-code`.

Regeneration on Linux also changes 35 PNGs from the Mac-generated candidate.
Decoded dimensions match, but pixels are not identical. Across those files,
279 of 154,229,568 channel values differ by one, with no larger difference.
The SVG input and raster algorithm are unchanged. This is measured renderer
variation, not a compression-only claim or an intentional artwork change.
Per-file raw hashes and renderer versions accompany the private review handoff.

Run `node --test scripts/branding-widget.test.mjs` on a Mac with Xcode. The test
exports the exact stock catalog from Git, copies both catalogs into temporary
paths and runs `xcrun actool` separately for stock and candidate. It checks for
`Assets.car` and reports toolchain versions and symbol digests. For a source
archive without Git objects, set `SMARTY_STOCK_WIDGET_CATALOG` to a separate
catalog exported from `2dfd1190eba8853c766c29ae27f09aeacc86bdb9`.

The Apple compiler test explicitly skips on Linux. Passing Linux branding tests
does not close the native build finding. A new exact-candidate Mac result and
independent review are still required. These checks do not launch an app or
change the maintained Mac product or its state.

Protected landing/CI and adoption of the **landed exact fork SHA** are separate
from this source candidate. Shared-fork metadata authorization is pending; no
protections/default branch/Mergify policy or maintained service is changed by
this port. No activation or restart is authorized by source delivery.
