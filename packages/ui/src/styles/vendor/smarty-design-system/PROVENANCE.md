# Smarty design system token pin

- Repository: `Smarty-Pants-Inc/smarty-pages`
- Commit: `173c0e50ecf5515aa2f9849e665f6c06dd587a0b`
- Source: `design-system/generated/tokens.css`
- Vendored file: `packages/ui/src/styles/vendor/smarty-design-system/tokens.css`
- Date: `2026-10-02`
- SHA-256: `854ab3e9bb8f0afe4dbfd99ec2bc81897e58267d9046ee2f4bdcecb1c7b3ade5`

`tokens.css` is a byte-exact copy of the generated upstream artifact. Do not edit
or regenerate it locally. Theme wiring and theme JSON are outside this pin.

## Reference-only sources

These files belong to the same upstream commit. Neither is vendored or imported.

| Source path | SHA-256 |
| --- | --- |
| `design-system/generated/theme.css` | `5c396b7b230c02d6909918f31c53336dc7aee06695402b9aaa34e52db612b280` |
| `design-system/tokens/tokens.json` | `b50dfc13cc3ed03f52c8612bd85fa05b5ed2a47cafd14df9cc54fdba53749c0f` |

This pin does not import upstream `theme.css`. Its ordinal spacing utilities use
literal pixels and would replace OpenChamber's existing spacing scale. The scale
remains unchanged. Typography and spacing alignment remain open on
`smarty-code#611`, pending the upstream scale alignment.

## Repin

Copy `design-system/generated/tokens.css` byte-for-byte from an approved upstream commit, update this commit/date and all source SHA-256 values, then run `node --test scripts/smarty-design-tokens.test.mjs`.
