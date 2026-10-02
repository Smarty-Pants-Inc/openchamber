# Smarty design system token pin

- Repository: `Smarty-Pants-Inc/smarty-pages`
- Commit: `5de7df8d2e15da6d6ca695cd1b36933ef6f4f7e0`
- Source: `design-system/generated/tokens.css`
- Vendored file: `packages/ui/src/styles/vendor/smarty-design-system/tokens.css`
- Date: `2026-10-02`
- SHA-256: `359b6e104c41ff0052abdb4886e097a963291a01a2a0dd788c87994b1068e6ef`

`tokens.css` is a byte-exact copy of the generated upstream artifact. Do not edit
or regenerate it locally. Theme wiring and theme JSON are outside this pin.

## Reference-only sources

These files belong to the same upstream commit. Neither is vendored or imported.

| Source path | SHA-256 |
| --- | --- |
| `design-system/generated/theme.css` | `60a11cc2b6fffee6e2af82cdab60a6e4fd5c5b3c23a5a7bdce24bb65e2a5c68f` |
| `design-system/tokens/tokens.json` | `42772b2be5e5db262a0a406a69edfe19a0149adfc6c32c662e5fb4dedfc9db41` |

This pin does not import upstream `theme.css` because OpenChamber's existing
aliases suffice. Upstream spacing utilities now use the `ds` namespace and do not
collide with numeric utilities. OpenChamber's existing numeric spacing scale
remains unchanged.

The pinned CSS provides `--primary-text`, `--status-success-text`,
`--status-error-text`, `--status-warning-text`, and `--status-info-text` for coloured
text, plus `--status-warning` and `--status-info` aliases. It also provides
`--syntax-*` colours and `--type-font-mono`, the platform monospace font stack for
code. Consumer mappings live in OpenChamber's theme generator, default theme JSON
and existing color aliases, outside the byte-exact CSS pin. Typography sizes and
spacing mapping remain open on `smarty-code#611`; monospace has an explicit
matching meaning.

The pinned CSS also provides `--status-{error,success,warning,info}-fill` and
`--status-on-{error,success,warning,info}-fill` pairs for filled status controls.
Use each fill with its matching on-fill token, not raw status fills or text
variants. Upstream audits these pairs at 4.5:1 for text and 3:1 for boundaries on
paper, elevated, muted and sidebar backgrounds.

## Next repin candidate

`Smarty-Pants-Inc/smarty-pages` PR #622, commit `67701893`, publishes the same
`5de7df8d` tokens plus shared components. It is not this pin; the package and
component CSS are not imported. Adopt it only through a separately verified repin.

## Repin

Copy `design-system/generated/tokens.css` byte-for-byte from an approved upstream
commit, update this commit/date and all source SHA-256 values, and update matching
JSON mirrors and tests as needed. Then run
`node --test scripts/smarty-design-tokens.test.mjs` and affected consumer tests.
