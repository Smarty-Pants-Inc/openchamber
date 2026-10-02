# Smarty design system token pin

- Repository: `Smarty-Pants-Inc/smarty-pages`
- Commit: `2fb4c7167745f874cfd82ffd56d4c799ca4472d0`
- Source: `design-system/generated/tokens.css`
- Vendored file: `packages/ui/src/styles/vendor/smarty-design-system/tokens.css`
- Date: `2026-10-02`
- SHA-256: `f052ff44063521157ec594b7de680e8c4ba868ea7202aced84aa91d7011eb129`

`tokens.css` is a byte-exact copy of the generated upstream artifact. Do not edit
or regenerate it locally. Theme wiring and theme JSON are outside this pin.

## Reference-only sources

These files belong to the same upstream commit. Neither is vendored or imported.

| Source path | SHA-256 |
| --- | --- |
| `design-system/generated/theme.css` | `59f7ed400b1bdc6a1ca06245271950dc905d2f518c1ca8ff79e3b8b68f752a38` |
| `design-system/tokens/tokens.json` | `1f9aff635daa3620c5d7a6069a07a33a7c36d5b6ebfcb800c69d90226f958954` |

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

## Repin

Copy `design-system/generated/tokens.css` byte-for-byte from an approved upstream
commit, update this commit/date and all source SHA-256 values, and update matching
JSON mirrors and tests as needed. Then run
`node --test scripts/smarty-design-tokens.test.mjs` and affected consumer tests.
