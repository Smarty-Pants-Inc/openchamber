# Default theme CSS contract

The shared UI uses the vendored Smarty Design System `tokens.css` for the two
registered default themes. The raw CSS is the palette authority; default JSON
mirrors its resolved roles for code renderers and other JavaScript consumers.
See [vendor provenance](../../styles/vendor/smarty-design-system/PROVENANCE.md)
for the exact upstream commit and file hash.

This is a color and default-monospace binding, not an import of upstream layouts,
components, UI typography, sizes or spacing. We do not load upstream `theme.css`
or replace OpenChamber's theme registry, presets or product identity.

## Default-only guard and stylesheet lifetime

`ThemeSystemContext.tsx` enables the pinned CSS only when the active theme is the
exact registered default-light or default-dark object returned by `getThemeById`,
and the runtime is not VS Code. A custom theme with a default ID, an embedded copy
or an old HMR object does not pass this identity guard. Matching names or IDs alone
must never enable the pin.

Generated variables and raw CSS share the replaceable theme stylesheet. Switching
to a custom or VS Code theme replaces that stylesheet and removes the pinned
layer; it must not leave raw variables behind. Raw fallback selectors use
`:where(...)` to avoid increasing selector specificity. Semantic aliases marked
`!important` override stale inline mobile-bootstrap defaults. The generated
primary foreground is emitted once, without a self-referencing variable.

The same default guard applies to web, Electron, hosted mobile and Capacitor.
VS Code keeps its supplied editor theme and does not receive the pin. Embedded
consumers only receive it if they use the registered object itself. Preference
publication remains owned by the provider: mounting, reloading or a system-derived
mode change is not a new user theme choice.

## Color roles

`cssGenerator.ts` maps raw roles to the existing OpenChamber contract:

| Role | Meaning |
| --- | --- |
| `--background`, `--foreground` | Default app surface and body text |
| `--surface-background`, `--surface-foreground` | Content surface and text |
| `--surface-elevated` | Elevated panels; foreground inherits the surface role |
| `--surface-muted`, `--surface-muted-foreground` | Muted regions and text |
| `--border`, `--interactive-border`, `--interactive-focus-ring` | Boundaries and focus |
| `--primary-base`, `--primary-text`, `--primary-foreground` | Accent/tint, readable accent text, text on accent |
| `--status-{error,warning,success,info}` | Raw status color for borders and tints |
| `--status-{error,warning,success,info}-text` | Status text on ordinary surfaces |
| `--status-*-background`, `--status-*-border` | Existing status containers |
| `--surface-sidebar`, `--sidebar-base`, `--sidebar-base-rgb` | Sidebar surface and its RGB companion |

Default JSON mirrors the selected raw semantic values for light and dark,
including chat/tool roles, rather than retaining a second default palette.
Keep text, tint and solid-fill roles separate. Text classes use the `*-text`
role; borders and tinted backgrounds keep the raw status/accent role. Badges may
mix a readable text role without changing their tint or border colors.

Custom themes may supply optional `primary.text`, status `errorText`,
`warningText`, `successText`, `infoText`, and `surface.sidebar`. Valid values are
trimmed, nonempty strings. Missing, empty or malformed optional text values fall
back to that custom theme's own raw accent/status color, never the pinned default.
Sidebar falls back to that theme's muted surface; its RGB companion follows the
resolved sidebar value. See the unchanged [custom theme guide](../../../../../docs/CUSTOM_THEMES.md)
for the broader schema and authoring workflow.

## Opaque status controls

Solid controls need a fill/on-fill pair, not ordinary status text or opacity:

| Tailwind alias | Raw role | Custom/VS Code fallback |
| --- | --- | --- |
| `destructive-solid` | `--status-error-fill` | `--destructive` |
| `destructive-solid-foreground` | `--status-on-error-fill` | `--destructive-foreground` |
| `status-success-solid` | `--status-success-fill` | `--status-success` |
| `status-success-solid-foreground` | `--status-on-success-fill` | Tailwind `--color-white` |
| `status-warning-solid` | `--status-warning-fill` | `--status-warning` |
| `status-warning-solid-foreground` | `--status-on-warning-fill` | `--background` |

`design-system.css` owns these six aliases. Delete confirmations use the error
pair; successful restart and loading-switch controls use success and warning
pairs. Error confirmations and mobile destructive controls keep opaque base,
hover and active fills. UpdateDialog's successful restart retains its existing
0.9 hover-opacity treatment. The raw stylesheet also provides an info pair; no
unused info-solid Tailwind API is introduced here.
These default pairs do not establish contrast guarantees for arbitrary custom
palettes or VS Code colors.

## Syntax and default monospace

Default syntax colors mirror the pinned semantic groups for comments, keywords,
strings, numbers, functions, variables, types and operators, plus punctuation.
Related syntax roles share a group intentionally; extra custom syntax fields keep
their own values. JavaScript-based highlighters consume the resolved JSON palette,
so they must agree with the raw CSS rather than relying on stylesheet inheritance.

The pinned mono stack feeds the default-monospace variable. It is selected only
for the default font choice. A user-selected mono font still wins, and UI fonts,
font sizes and spacing remain OpenChamber-owned.

## Checks and ownership

`pinnedTokens.test.ts` checks default JSON role mirrors, syntax, mono stack and
paired solid consumers. `optionalColors.test.ts` covers fallback parsing, and
`scripts/smarty-design-tokens.test.mjs` checks the exact vendor digest. Provider
guard, stylesheet replacement and preference-publication probes are separate
acceptance evidence, not claims made by those pinned-token tests. Branding checks
bind the eight overlapping managed source outputs without regenerating branding
manifests or the custom guide.

Source checks do not prove browser paint, mobile bootstrap timing, native font
availability or installed-platform behavior. Those require runtime-specific
acceptance on the final integrated source and served artifact.
