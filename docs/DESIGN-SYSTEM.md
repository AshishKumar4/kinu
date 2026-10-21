# The Kinu design system

The rules the app holds for colour, type, space, radius, elevation, motion and components. `tests/design-system.test.ts`
enforces §4; `tests/browser/palette-ux.test.ts` holds §1.1's contrast floors; `?frame=system` in the design gallery
draws every token and component in all four looks.

**Status:** written 2026-10-20 from `design/whole-app` at `aba14b1ee`; built from 2026-10-21. It states the rules the code holds in one place and a gate can enforce.

**The one source of values:** every colour, shadow colour and radius lives in `packages/core/src/web/theme.ts`.
- `packages/cf-backend/src/index.css` maps those tokens onto role classes and component classes.
- The component set lives in `packages/cf-backend/src/components/ui/`, and pages and features compose it.

Nothing else writes a value.

**Evidence:**
- contrast numbers: `audit/contrast.py`, computed from `theme.ts` as it stands
- deviation counts: `audit/audit.py` → `audit/audit.json`, a static scan of 406 files

---

## 0. Five rules the system rests on

1. **One value, one place.** A colour or radius written anywhere but `theme.ts` is a defect. A size written anywhere but the role table is a defect.
2. **Pages compose, components draw.** A page or feature component never styles a box. It picks a component, a role and a layout.
3. **Same thing, same drawing.** Where two places show one concept (an agent, a status, unsaved changes, a connected thing), they render the same component.
4. **Quiet by default.**
   - One accent: brass, for the one primary action, the selection and focus.
   - Hairlines, not boxes.
   - No shadow on anything that doesn't float.
5. **Measured, not eyeballed.** Every text/ground pair has a contrast floor (§1.1), and the palette test holds every look to it.

---

## 1. Tokens

### 1.1 Palette roles
Define every role for all four looks in `theme.ts`. Each value below is today's unless marked **new** or **changed**.

**Grounds**

| role | use | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|---|
| `--c-bg` | page canvas | `#F9F9F8` | `#100F0E` | `#E9E2D3` | `#0F0D0B` |
| `--c-sidebar` | sidebar, phone app bar | `#F3F2F1` | `#141413` | `#F1EBDD` | `#141110` |
| `--c-sunken` (was `recessed`) | capture mats, code wells, segmented track | `#EAE9E8` | `#0B0A09` | `#E0D8C5` | `#131110` |
| `--c-surface` | cards, tiles, list groups | `#FFFFFF` | `#1A1918` | `#F7F3E9` | `#181512` |
| `--c-field` (was `input-bg`) | text fields | `#FFFFFF` | `#090807` | `#F7F3E9` | `#0B0A09` |
| `--c-fill` | typeset covers, placeholders (one step off `surface` in every look) | `#EFEEED` | `#1F1E1D` | `#E5DCC8` | `#1B1713` |
| `--c-overlay` | menus, dialogs, popovers, save bar | `#FFFFFF` | `#252423` | `#F7F3E9` | `#221C15` |

**Interaction**

| role | use | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|---|
| `--c-hover` (was `neutral-tint`) | any hovered row or ghost control | `rgba(25,24,22,0.06)` | `rgba(237,235,232,0.06)` | `rgba(43,36,25,0.07)` | `rgba(237,229,216,0.06)` |
| `--c-pressed` **new** | pressed row or ghost control | `rgba(25,24,22,0.10)` | `rgba(237,235,232,0.10)` | `rgba(43,36,25,0.11)` | `rgba(237,229,216,0.10)` |
| `--c-selected` (was `accent-subtle`) | the open nav row, a chosen card | `rgba(190,125,29,0.12)` | `rgba(224,164,88,0.12)` | `rgba(216,154,68,0.16)` | `rgba(224,164,88,0.12)` |

**Lines**

| role | use | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|---|
| `--c-border` | hairlines: cards, headers, columns | `#DAD9D8` | `#323130` | `#D2C6AE` | `#262019` → **`#302920`** |
| `--c-border-strong` | hovered tile edge, emphasis | `#8B8A89` | `#666664` | `#8F7F62` | `#696257` |
| `--c-field-border` (was `input-border`) | text fields, checkbox, switch off | `#8B8A89` | `#666664` | `#8F7F62` | `#696257` |
| `--c-dash` | dividers between rows in a group | `#E4E3E1` | `#292928` | `#DBD1BE` | `#2A241D` |

**Text**

| role | use | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|---|
| `--c-text` | primary ink | `#191816` | `#EDEBE8` | `#1C1710` | `#EDE5D8` |
| `--c-text-2` | secondary ink, body | `#3C3A38` | `#D2D1CE` | `#3D3427` | `#D8CFC2` |
| `--c-text-3` | meta, hints, placeholders, icons | `#615F5D` | `#9D9C99` | `#5E5344` | `#9C9184` |

**Accent and focus**

| role | use | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|---|
| `--c-accent` | brass fill: primary button, switch on, active tab bar | `#BE7D1D` | `#E0A458` | `#B17513` | `#E0A458` |
| `--c-accent-fg` | brass as text or icon on a ground | `#865713` | `#E6D3AC` | `#7A5514` | `#E3D2AE` |
| `--c-accent-on` | text on a brass fill | `#1F1306` | `#1F1306` | `#1F1503` | `#1A1408` |
| `--c-focus` **new** | focus ring | `#9D691C` | `#E0A458` | `#936212` | `#E0A458` |

**Status**

| role | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|
| `--c-success` / `-tint` | `#29723E` / `.10` | `#7CCD8E` / `.14` | `#316530` / `.11` | `#8FBC8B` / `.14` |
| `--c-warning` / `-tint` | `#796300` / `.10` | `#E4CE63` / `.14` | `#715A00` / `.10` | `#DAC077` / `.14` |
| `--c-danger` / `-tint` | `#AB4335` / `.10` | `#EF7F72` / `.14` | `#96412C` / `.11` | `#C97B6B` / `.14` |
| `--c-info` / `-tint` | `#2A6999` / `.10` | `#7EBCE8` / `.14` | `#2F6289` / `.08` | `#8FB6D6` / `.14` |
| `--c-danger-on` **new** (text on danger fill) | `#FFFFFF` | `#1A0B08` | `#FFFFFF` | `#1A0B08` |

**Buttons** (all **new**, REREVIEW-2 A4)

| role | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|
| `--c-button-bg` | `#FFFFFF` | `#232221` | `#FBF8F1` | `#201B16` |
| `--c-button-bg-hover` | `#F4F4F3` | `#2A2928` | `#F3EEE2` | `#27211A` |
| `--c-button-bg-active` | `#ECECEA` | `#1E1D1C` | `#ECE5D5` | `#1B1713` |
| `--c-button-line` | `rgba(25,24,22,.13)` | `rgba(237,235,232,.09)` | `rgba(43,36,25,.15)` | `rgba(237,229,216,.09)` |
| `--c-button-line-hover` | `rgba(25,24,22,.20)` | `rgba(237,235,232,.15)` | `rgba(43,36,25,.22)` | `rgba(237,229,216,.15)` |

**Chat** (approved; unchanged)

| role | Graphite light | Graphite dark | Warm light | Warm dark |
|---|---|---|---|---|
| `--c-user-bg` / `-border` | `#F5E2C4` / `#DDBF91` | `#302416` / `#4C3922` | `#F2D9AC` / `#D9B573` | `#241E16` / `#3A3126` |
| `--c-composer-bg` | `#FFFFFF` | `#181716` | `#F8F4EB` | `#1A1714` |

`--c-composer-line` and `--c-composer-line-focus` keep their values.

**Effects:** `--c-scrim`, `--shadow-button` (**new**, A4), `--shadow-menu`, `--shadow-overlay` and `--shadow-composer` keep today's values. `--shadow-card` stays `none`.

**Illustration** (**new** table): the mascot and mark colours now hard-coded in `components/Marks.tsx` move to an exported `ILLUSTRATION` constant in `theme.ts`, read by `Marks.tsx`. The values are `#1F7A72 #2FA39A #3366B5 #4A4366 #4C86E0 #8C86A3 #C94F88 #E0524F #EC6FA8 #F07FAE #F2BE45`, unchanged.

**Contrast floors.** `tests/browser/palette-ux.test.ts` holds every look to these. Today's lowest values below come from `audit/contrast.py`.

| pair | floor | today's lowest (look) |
|---|---|---|
| `text` on bg, surface, overlay | 12:1 | 13.8 (Warm light) |
| `text-2` on bg, surface | 7:1 | 9.5 (Warm light) |
| `text-3` on bg, sidebar, surface, overlay, fill, hover, sunken | 4.5:1 | 5.13 (Warm light on hover) |
| `accent-fg` on bg, surface, selected | 4.5:1 | 4.71 (Warm light on selected) |
| `accent-on` on accent | 4.5:1 | 4.65 (Warm light) |
| `accent` fill on bg (a primary must read as an object) | 3:1 | 3.0 (Warm light) |
| status ink on bg, surface, and its own tint | 4.5:1 | 4.51 (Warm light warning on tint) |
| `danger-on` on danger | 4.5:1 | 5.86 (new) |
| `field-border` on bg, surface, field | 3:1 | 3.02 (Warm dark on surface) |
| `focus` on bg, surface | 3:1 | 4.07 (Warm light, new) |
| `border` on bg and surface (a hairline, visible but quiet) | 1.15–1.6:1 | **1.13 (Warm dark on surface)** → `#302920` gives 1.27 |

### 1.2 Delete, merge or rename

| today | becomes | uses today | why |
|---|---|---|---|
| `--c-text-4` (`p-text-4`) | `--c-text-3` | 101 + 7 | It sits 0.7–1.3 ratio points below text-3 (Graphite light 5.35 vs 6.03, Warm light 5.03 vs 5.82). Both are 'quiet grey', and the pair reads as one tier. |
| `--c-elevated` (`p-elevated`, `p-card-hover`) | `--c-hover` over the row's own ground | 48 + 22 | It is a solid hover fill that is *darker* than bg in light and lighter in dark. In Warm light it is 1.02:1 from bg, which is invisible. |
| `--c-neutral-tint` | `--c-hover` | 59 | Renamed for its job. |
| `--c-accent-subtle` | `--c-selected` | — | Renamed for its job. |
| `--c-recessed` | `--c-sunken` | 13 + 36 | Renamed for its job. |
| `--c-input-border`, `--c-input-bg` | `--c-field-border`, `--c-field` | 7 | Renamed; the button no longer borrows the field's edge. |
| `--c-code` | `--c-accent-fg` | 5 | Identical value in all four looks. |
| `--c-accent-mark` | keep | 16 | It resolves differently per mode on purpose (accent-fg in light, accent in dark) for small brass marks. |
| `.p-display`, `.p-heading` | `t-page-title`, `t-title` | 11, 5 | One title role per level. |
| `.p-eyebrow`, `.p-label`, `.p-label-sm` | `t-label` | 32, 6 | Already identical (13/600 text-2). |
| `.p-annotation` (mono 10 px) | `t-meta` + `t-mono` | 43 | Mono is for code. A 10 px caption is below the floor. |
| `.p-t-status` | `t-status` | 45 | — |
| `.p-meta`, `.p-row-text`, `.p-title`, `.p-t-control` | `t-meta`, `t-body`/`t-item`, `t-title`, `t-control`/`t-nav` | 383, 223, 14, 35 | Renamed into one `t-` family. |
| `.p-btn`, `.p-btn-quiet`, `.p-btn-ghost`, `.p-btn-danger` | `Button` | 0 in TSX; still defined in CSS | Delete the CSS. |
| `.p-notice-*` (5 classes) | `Notice` (Kumo `Banner`) | — | — |
| Tailwind `--radius-xs/sm/md/lg/xl` remap in `index.css:75-79` | deleted | — | Feature code may not round, so the remap only invites `rounded-lg` = 12. |
| `--dur-base` 150 | `--dur-state` 120 | — | Two state durations 30 ms apart read as one. |
| literal durations 260/280/700/1100 ms in `index.css` | `--dur-*` | 6 | — |
| 7 hex + 4 `rgba()` literals in `index.css` | `theme.ts` | 11 | — |

### 1.3 Type roles (Inter; Fragment Mono for code)
**Sizes are rendered px.**
- The gallery's `size-adjust: 96.5%` on Inter is a review device and does not ship.
- The chat keeps prod's x-height through its own role: prod Schibsted 16 → Inter 15.5; workbench 14.5 → Inter 14.
- Classes are `t-*` and are the only way to set a size, weight, leading or tracking.

| role | class | size / line | weight | tracking | default ink | used for |
|---|---|---|---|---|---|---|
| hero | `t-hero` | 36 / 44 | 600 | −0.015em | text | the `/new` question only |
| page title | `t-page-title` | 24 / 32 | 600 | −0.011em | text | `PageHeader`, flow cards |
| title | `t-title` | 15 / 22 | 600 | −0.005em | text | tile title, `ToolBar` title, dialog title, in-card heading |
| nav | `t-nav` | 14 / 20 | 500 | 0 | text-2; open: accent-fg | sidebar, Settings rail, tab strips |
| section label | `t-label` | 13 / 20 | 600 | 0 | text-2 | the label above every group |
| item | `t-item` | 13 / 20 | 500 | 0 | text | row name, field label, table primary cell |
| body | `t-body` | 13 / 20 | 400 | 0 | text-2 | descriptions, UI paragraphs |
| control | `t-control` | 13 / 20 | 500 (primary 600) | 0 | per variant | buttons, segmented, menu items, field values (400) |
| meta | `t-meta` | 12 / 16 | 400 | 0 | text-3 | time, count, hint, caption (`tabular-nums` included) |
| status | `t-status` | 12 / 16 | 500 | 0 | tone | `Status`, `Chip` |
| micro | `t-micro` | 11 / 14 | 600 | 0.01em | per use | `Badge` and counters only |
| chat | `prose-chat` | 15.5 / 26 (workbench 14 / 24) | 400 | 0 | text | assistant prose, the person's bubble |
| composer | `t-composer` | 15.5 / 24 | 400 | 0 | text | composer input |
| code | `t-code` | Fragment Mono 13 / 20; inline 0.92em | 400 | 0 | accent-fg | code, paths, keys, env names |

- **Font sizes:** 14 roles replace today's spread. That spread is 15 role classes, 317 Tailwind size utilities, 71 `text-[…]` literals in 16 sizes (8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 22 px), and 25 distinct `font-size` values in `index.css`.
- **Weights:** only 400, 500 and 600, each set by its role. 700 is not used.
- **Named variants:** approved and settled parts keep their own sizes, each named for what it is and written once, as a
  `--t-*` property in `index.css`. Nothing else writes these sizes.

| variant | property | size | for |
|---|---|---|---|
| `role.chat-heading` | `--t-chat-heading-1/2/3` | 22, 19, 17 (workbench 1.1, 1.05, 1 em of its 14) | a report's headings: assistant prose (approved), and the plan document's h2 |
| `role.code-workbench` | `--t-code-workbench` | 12.5 | the code block inside the workbench (approved) |
| `role.workspace-tab` | `--t-workspace-tab` | 13.5 | the workspace tab's title (settled) |
| `role.field-touch` | `--t-field-touch` | `max(16px, 1em)` | a field's value on a touch screen: iOS Safari zooms the page into any field under 16 px |

### 1.4 Spacing
- **Scale:** 4, 8, 12, 16, 20, 24, 32, 48, 64. Tailwind units 1, 2, 3, 4, 5, 6, 8, 12, 16, plus 0 and `px`.
- **Inside `components/ui/` only:** 2 and 6 (units 0.5 and 1.5), for a dot-to-label gap or a segmented thumb inset.
- **Page rhythm**, held by `Page` (unchanged since the first review):

  | step | desktop | phone |
  |---|---|---|
  | top inset | 48 | 24 |
  | header row | 36 | — |
  | header to hairline | 20 | — |
  | hairline to body | 32 | — |
  | between groups | 32 | — |
  | label to group | 8 | — |
  | card padding | 20 | — |
  | tile gap | 20 | — |
  | foot | 64 | — |

- **Layout constants** (`--layout-*` in `index.css`, the only arbitrary values feature code may name):

  | constant | value |
  |---|---|
  | `frame` | 1152 |
  | `gutter` | 32 (phone 20) |
  | `bar` | 46 (phone 48) |
  | `sidebar` | 240 |
  | `tile-min` | 300 |
  | `chat-column` | 780 (`.p-thread-column`) |
  | `tool-list` | 400 |
  | `tool-places` | 220 |
  | `reader` | 760 |

### 1.5 Radii (`RADII` in `theme.ts`)

| token | px | for |
|---|---|---|
| `--r-check` | 4 | checkbox only |
| `--r-inner` | 6 | a segmented thumb, an image inside a mat, a code chip |
| `--r-control` | 8 | button, field, select, segmented track, icon button, ⋯, badge, tooltip |
| `--r-row` | 12 | nav rows, list rows, menus, notices |
| `--r-card` | 14 | card, tile, dialog, popover, save bar |
| `--r-pill` | 999 | chip, status pill, avatar, switch, meter |

Named variants, in `theme.ts` beside the six, for the approved composer and the settled workspace tab:

| variant | token | px | for |
|---|---|---|---|
| `radius.composer` | `--r-composer` | 24 | the composer (approved) |
| `radius.workspace-tab` | `--r-workspace-tab`, `--r-workspace-tab-outline`, `--r-workspace-tab-flare` | 7, 10, 8 | the tab's rename field, its outline's top corners, its flared feet (settled) |

`--r-overlay` merges into `--r-card`. These six and the named variants are the only radii: no `rounded-*` utility and no `rounded-[…]` outside `ui/`.

### 1.6 Elevation

| level | token | for | dark |
|---|---|---|---|
| 0 | none | card, tile, group, page: hairline only | ground step + hairline |
| 1 | `--shadow-button` | secondary and primary buttons, segmented thumb | inset top highlight |
| 2 | `--shadow-menu` | menu, popover, tooltip, toast, save bar | as today |
| 3 | `--shadow-overlay` | dialog | as today |
| — | `--shadow-composer` | the composer, alone | as today |

### 1.7 Motion

| token | value | for |
|---|---|---|
| `--dur-state` | 120 ms, ease-out | colour, border, background, shadow changes on hover, press and selection |
| `--dur-enter` | 220 ms, `--ease-out-strong` | menus, dialogs, toasts, save bar: opacity plus 8 px (dialog: also scale .98→1) |
| `--dur-fold` | 300 ms, `--ease-out-strong` | disclosure and fold (`.p-fold`) |
| `--ease-glide` | `cubic-bezier(0.32, 0.72, 0, 1)` | a selection that travels (segmented thumb, tab outline) |

- **No press scale.** Nothing translates on hover.
- **Reduced motion:** opacity and colour only.

---

## 2. Components
**Rule:** features import only from `@/components/ui`.

**Rule for the base:**
- Kumo's **styled** component when its size table and theming can hit the spec through the `--color-kumo-*` bridge in `index.css`, plus one `className` in our wrapper.
- Kumo's **Base UI primitive** (`@cloudflare/kumo/primitives`) with our skin, when the look is ours but the behaviour (focus, keys, ARIA) is solved.
- **Ours** only for what neither covers.

Kumo is imported in exactly one place per component: its `ui/` wrapper.

| component | file | base | sizes and variants | states |
|---|---|---|---|---|
| **Button** | `ui/Button.tsx` | ours, on the Kumo `button` primitive. Kumo's styled `Button` hard-codes `!text-white` on primary and destructive (white on brass measures 3.42 in Graphite light, 3.87 in Warm light and 2.18 on the dark brass; all fail 4.5 for 13 px text) and is 26/36 tall. | md 32, sm 28 (lg 40 only if the flows take it, both flows). primary, secondary, ghost, danger, destructive (confirm only). | rest, hover, active, focus-visible, disabled, busy (spinner replaces the icon, width held). Disabled is the variant's own shape, muted: a filled variant takes the flat `--c-hover` fill, a ghost stays unfilled, both in text-3 ink, so a disabled control never reads as pressed |
| **IconButton** | `ui/Button.tsx` (`iconOnly`) | as Button | 32, 28; and 22 inside the workspace tab only | as Button; always `aria-label` + tooltip |
| **InlineAction** | `ui/InlineAction.tsx` | ours | the sentence's own type, accent-fg ink | rest, hover (underline), disabled (text-3). An action inside running text: a file named in an answer, the agent a task belongs to. A link to a page stays an `<a>` |
| **Field** (label, hint, error) | `ui/Field.tsx` | ours. Layout only: label `t-item`, hint `t-meta` one line, error `t-meta` danger. | stacked, inline (control right) | — |
| **TextInput / TextArea** | `ui/Field.tsx` | Kumo `Input` / `InputArea`, wrapper sets the height | md 32, sm 28; TextArea min 80, `mono` for SOUL.md | rest, hover (border-strong), focus (border `--c-focus`), invalid (border danger), disabled (.5) |
| **Select / Combobox** | `ui/Select.tsx` | Kumo `Select` / `Combobox` | md 32, sm 28 | as TextInput; menu as **Menu** |
| **Checkbox / Radio** | `ui/Check.tsx` | Kumo | 16 | off, on, mixed, focus, disabled |
| **Switch** | `ui/Switch.tsx` | ours, on the Kumo `switch` primitive. Kumo's styled switch is 22×34 / 26×42 squircles. | 32×18 track, 14 thumb (white both modes) | off (track `--c-field-border` at 60%), on (accent), focus, disabled. **Always beside a visible label.** |
| **Segmented** | `ui/Segmented.tsx` | ours, on the Kumo `toggle-group` primitive | md 32, sm 28; text or icon segments | thumb `--c-button-bg` + line + `--shadow-button`; unselected text-2 → hover text; arrow keys |
| **Tabs** (underline strip) | `ui/Tabs.tsx` | ours, on the Kumo `tabs` primitive | 40 tall | text-3 → hover text-2 → active accent-fg + 2 px accent bar; strip hairline. Workspace tabs are settled and stay as they are. |
| **Status** | `ui/Status.tsx` | ours | 6 px dot + `t-status` | success, warning, danger, info, neutral, accent. Never a pill, never a ⌄. |
| **Chip** | `ui/Chip.tsx` **new** | ours | 24 tall, px 8, `--r-pill`, `t-status` | neutral (`--c-hover`), tone (its tint + ink); optional 14 icon; optional remove (16 ghost ×) |
| **Badge** | `ui/Badge.tsx` (replaces `KindBadge`, Kumo `Badge` uses) | ours | 20 tall, px 6, `--r-control`, `t-micro` | neutral, accent, on-picture (over a cover: `--c-overlay` at 92%) |
| **Avatar / WorkspaceLogo / ChatMascot** | `ui/Avatar.tsx`, `Marks.tsx` | ours | 20, 24, 32 | an agent is **always** its mascot; a workspace its logo or letter; a person their initials |
| **Row** (the connected-thing row) | `ui/Row.tsx` (from `PluginRow`) | ours | grid `32px 1fr 120px 28px` (REREVIEW-2 A3), min-h 56, px 8, `--r-row`; one-line variant min-h 40; phone collapses to `32px 1fr 28px` | rest, hover `--c-hover`, selected `--c-selected`, focus-within ring |
| **Group** (rows in one box) | `ui/Group.tsx` (from `.p-group`) | ours | `--c-surface`, 1 px border, `--r-card`, rows split by 1 px dashed `--c-dash` | — |
| **Menu / RowMenu** | `ui/Menu.tsx` | Kumo `DropdownMenu` (keys, typeahead, focus) | min-w 180, padding 4, items 32 tall px 8 `--r-control`, icon 16 text-3, separator 1 px | highlight `--c-hover`; danger item danger ink on `--c-danger-tint`; enter `--dur-enter` |
| **Card** | `ui/Card.tsx` (from `form.tsx`) | ours | `t-label` above (8 gap), optional sm actions on the label row; body `--c-surface`, border, `--r-card`, padding 20, gap 20 | **never contains a Card, Group or tinted box** |
| **Tile** (`TILE_GRID`, `TileShell`) | `ui/Tiles.tsx` | ours | grid min 300, gap 20; 16:10 cover over a hairline; body px 16 pt 12 pb 14, `t-title` + up to two `t-meta` lines | rest, hover (border-strong, `--dur-state`), focus-visible ring |
| **Cover: Capture** | `ui/Tiles.tsx` | ours | `--c-sunken` mat, 12 inset, picture `--r-inner` | captured in the viewer's mode once both captures exist |
| **Cover: Typeset** | `ui/Tiles.tsx` | ours | `--c-fill` ground (fixes dark holes), mark 32 top-left (`WorkspaceLogo` / `ChatMascot` / none when a badge sits there), line 17/24 500 text-2, clamp 3 | — |
| **PageHeader / Page** | `ui/PageHeader.tsx` | ours | frame page: icon 20 or back link, `t-page-title`, actions md 32 at the right line, hairline | `rule="wide"` when a tab strip follows on phone |
| **ToolBar / ToolPage** | `ui/PageHeader.tsx` | ours | 46 bar, icon 18 + `t-title`, 28-tall controls, hairline (REREVIEW-2 A2) | — |
| **ChatBar** | `WorkspaceHeader.tsx` | ours | 46 bar; Focus: no hairline + 20 px fade; Workbench: tabs + hairline (A1) | — |
| **FlowCard** | `ui/FlowCard.tsx` **new** (Welcome, Deploy) | ours | 520 card, logo, `t-page-title`, step dots, footer with md buttons | — |
| **SaveBar** | `ui/SaveBar.tsx` **new** | ours | floating, sticky bottom 16, 48 tall, `--r-card`, `--c-overlay`, `--shadow-menu`; "Unsaved changes" + Discard (ghost sm) + Save (primary sm) | hidden, dirty, saving, saved (1.5 s), error (`t-meta` danger, bar stays) |
| **Dialog / ConfirmDialog** | `ui/Dialog.tsx` (from `Modal`, `ConfirmDialog`) | Kumo `Dialog` | widths 440 / 560 / 720, padding 24, `--r-card`, `t-title`, footer right: secondary Cancel + primary (or destructive for a confirm) | enter `--dur-enter`; scrim; focus trap; Esc; destructive opens focused on Cancel |
| **Popover** | `ui/Popover.tsx` | Kumo `Popover` | `--r-card`, padding 12, elevation 2 | — |
| **Tooltip** | `ui/Tooltip.tsx` | Kumo `Tooltip` | inverse: `--c-text` ground, `--c-bg` ink, `t-meta`, px 8 py 4, `--r-control`, 400 ms delay, no arrow | — |
| **Toast** | `ui/Toast.tsx` | Kumo `Toast` | 360 wide, bottom right, `--r-card`, elevation 2, tone as a `Status` dot | auto-dismiss 5 s; danger stays |
| **Notice** | `ui/Notice.tsx` | Kumo `Banner` | inline: tone tint ground, 1 px tone line at 30%, `t-body` in tone ink, icon 16, padding 12/16, `--r-row` | info, warning, danger, success |
| **Empty** | `ui/Empty.tsx` | Kumo `Empty` | icon 24 text-3, `t-item`, `t-body`, one secondary action; padding 48 | — |
| **Loader / Skeleton** | `ui/Loader.tsx` | Kumo `Loader`; ours `Skeleton` | spinner only inside a busy button or under 1 s; skeleton bars for content | — |
| **Meter** | `ui/Meter.tsx` | Kumo `Meter` | 4 tall, `--r-pill`, track `--c-hover` | accent; warning at 80% and above; danger at 100% |
| **Table** | `ui/Table.tsx` | Kumo `Table` | `t-item`/`t-body` cells, `t-meta` heads, rows 40, dashed dividers | — |
| **CopyField** | `ui/CopyField.tsx` | Kumo `ClipboardText` | mono value in a `--c-sunken` well, copy IconButton | copied (check for 1.5 s) |
| **SecretInput** | `ui/SecretValue.tsx` | Kumo `SensitiveInput` | as TextInput | — |
| **Composer, prose, code block** | `Composer.tsx`, `.prose-chat`, `.p-code` | ours | approved | — |

---

## 3. Audit: today's deviations
**Scan:** `audit/audit.py` over `packages/cf-backend/src` at `aba14b1ee`, covering 406 `.ts`/`.tsx` files.
- **Excluded:** `gallery*`, `components/landing/`, tests and `diff-design/`.
- **Method:** pattern counts, so a few hits are false positives (a hex in a comment, a `<button>` inside a component that should own it). The kinds and ranking hold.

### 3.1 By kind

| kind | total | outside `components/ui/` |
|---|---|---|
| off-scale spacing (`*-0.5/1.5/2.5/3.5/7/9/10/11/14`) | 640 | 626 |
| Tailwind radius step (`rounded`, `rounded-sm/md/lg/xl…`) | 322 | 315 |
| Tailwind text size (`text-xs/sm/base/lg/xl/2xl`) | 317 | 309 |
| raw `<button>` | 280 | 273 |
| arbitrary colour `[var(--c-…)]` / `color-mix` in a class | 206 | 183 |
| font-weight utility | 176 | 170 |
| px literal `*-[Npx]` | 159 | 152 |
| raw `<input>`/`<select>`/`<textarea>` | 111 | 111 |
| `text-[Npx]` literal | 71 | 68 |
| inline `style={{…}}` | 60 | 50 |
| `p-card` used directly | 56 | 54 |
| raw hex | 39 | 38 |
| `rounded-[…]` | 29 | 24 |
| `shadow*` utility | 13 | 12 |
| `leading-[…]` / `tracking-[…]` | 10 | 10 |
| raw `rgb()`/`hsl()`/`oklch()` | 8 | 7 |
| Tailwind palette colour (`bg-white`, `bg-black`, `text-purple-500`) | 7 | 5 |
| **total** | **2,504** | **2,407** |

**`index.css`:**
- 2,246 lines and 203 `.p-*` classes.
- 7 hex and 4 `rgba()` literals.
- 25 distinct `font-size` values (13px, 12.5px, 1rem, 12px, 0.875rem, 0.8125rem, 11px, 0.75rem, 11.5px, 0.875em, 0.6875rem, 10px, 1.5rem, 1.375rem, 13.5px…).
- 20 distinct `border-radius` values (999px, 50%, 7px, 8px, 10px, 12px, 6px, 9px, 4px, 2px, 9999px and the tokens).
- 8 distinct durations (120, 150, 220, 260, 280, 300, 700, 1100 ms).

**Type roles in use:** `p-meta` 383, `p-row-text` 223, `p-t-status` 45, `p-annotation` 43, `p-t-control` 35, `p-eyebrow` 32, `p-t-code` 16, `p-title` 14, `p-display` 11, `p-label` 6, `p-heading` 5, `p-page-title` 2. Beside these sit 317 Tailwind sizes and 71 literal sizes, so roughly one size in three bypasses the roles.

### 3.2 By area

| area | deviations |
|---|---|
| `components/*.tsx` (top level: MessageView, Sidebar, Composer, WorkspaceHeader…) | 605 |
| `components/surfaces/` | 521 |
| `pages/` | 400 |
| `components/account/` | 225 |
| `components/plan-review/` | 153 |
| `components/slates/` | 152 |
| `components/ui/` | 97 |
| everything else | under 60 each |

### 3.3 Top offenders (all kinds)

| file | count | mostly |
|---|---|---|
| `components/surfaces/FilesSurface.tsx` | 73 | spacing 22, raw buttons 18 |
| `components/plan-review/Viewer.tsx` | 73 | text sizes 18, radii 17 |
| `pages/DrivePage.tsx` | 68 | spacing 19, px literals 12, text literals 8, `SECTION_HEADING` |
| `components/slates/LiveShareForm.tsx` | 61 | spacing 25 |
| `pages/SettingsPage.tsx` (workspace settings) | 61 | spacing 17, radii 12, sizes 11, raw buttons 9 |
| `components/surfaces/ExplorationSurface.tsx` | 54 | spacing 35 |
| `components/surfaces/changes/ChangesPanel.tsx` | 53 | — |
| `components/MessageView.tsx` | 51 | — |
| `components/plan-review/AnnotationPanel.tsx` | 51 | `text-[10px]`, px literals, `text-purple-500` |
| `components/ProfileCatalogSettings.tsx` (Models) | 48 | — |
| `components/WorkspaceAutomations.tsx` | 43 | — |
| `components/Sidebar.tsx` | 42 | — |
| `components/surfaces/ActivitySurface.tsx` | 42 | — |
| `components/surfaces/changes/parts.tsx` | 41 | — |
| `pages/ExploreWorkspacePage.tsx` | 41 | — |

### 3.4 Worst single cases
- **Raw colour:**
  - `components/Marks.tsx`: 22 hex. The illustration palette, which moves to `theme.ts` `ILLUSTRATION`.
  - `preview-proxy.ts`: 14 hex and 4 `rgba()`. A server-rendered page with its own warm palette; it should inline `THEME_CSS` and use `var(--c-*)`.
  - `components/mail/MailMessage.tsx:37`: `bg-white`. The mail iframe frame should be `--c-surface`.
  - `components/plan-review/AnnotationPanel.tsx:34`: `text-purple-500`.
  - `components/ui/BrandMark.tsx:119`: `bg-[#111318]`.
- **Most arbitrary colours:** `components/account/AppearanceCard.tsx` (17), `components/ui/form.tsx` (8), `components/nav.ts` (7).
- **Raw controls:**
  - `FilesSurface.tsx`: 18 `<button>`.
  - `Composer.tsx`: 12.
  - `pages/DeployPage.tsx`: 8 raw inputs.
  - `DriveActions.tsx`: 7.
  - The Models `Test` button (24 / r4) and `New role` (36) are both raw.
- **Second implementations of a component:**
  - two save bars (D2)
  - the device grant chip (D4)
  - `KindBadge` beside Kumo `Badge`
  - `SECTION_HEADING` beside `.p-label`
  - workspace settings' 28/11 segmented and three-button approval choice
  - `RowMenu` hand-rolled beside Kumo `DropdownMenu`
  - `Modal` beside Kumo `Dialog`

---

## 4. Enforcement: what code may write
The gate is a static test, `tests/design-system.test.ts` (bun, no browser). It scans `packages/cf-backend/src/**/*.{ts,tsx}` and `index.css` and fails with `file:line` and the rule broken.

There is **no allowlist and no ratchet** (the owner's rule): the gate lands when the migration has driven every count to zero, and from then on the rules are absolute. It sits beside `tests/browser/computed-style.test.ts` (no unresolved tokens at runtime) and `tests/browser/palette-ux.test.ts` (the §1.1 contrast floors in all four looks).

### 4.1 Page and feature code
This means everything outside `components/ui/`, `theme.ts` and `index.css`.

**May write:**
- Imports from `@/components/ui/*` and from feature modules.
- Icons from `@phosphor-icons/react` with `size` in {14, 16, 18, 20, 24}.
- Layout utilities: `flex`, `grid`, `grid-cols-N`, `col-span-N`, `items-*`, `justify-*`, `self-*`, `order-*`, `relative/absolute/sticky/fixed`, `inset/top/left/right/bottom` on the scale, `z-{0,10,20,30,50}`.
- Size: `w-*`/`h-*`/`min-*`/`max-*` on the scale or `full`, `screen`, `auto`, `fit`, `min`, `max`, `0`, or `[var(--layout-*)]`.
- `overflow-*`, `truncate`, `line-clamp-{1,2,3}`, `sr-only`, `hidden`, `block`, `contents`.
- Responsive and state prefixes (`sm: md: lg: hover: focus-visible: group-*`) on any allowed utility.
- Spacing (`p* m* gap* space-*`) in units {0, px, 1, 2, 3, 4, 5, 6, 8, 12, 16}.
- Type: `t-*` role classes and `tabular-nums`.
- Ink: the semantic ink classes `p-text`, `p-text-2`, `p-text-3`, `p-accent-fg`, `p-success`, `p-warning`, `p-danger`, `p-info`.
- Rules: `border-{t,b,l,r,x,y}` together with `p-border`, for a section divider.
- `style={{…}}` only for data-driven geometry: `width`, `height`, `left`, `top`, `transform`, `gridTemplateColumns` and `--*` custom properties, with values computed from data.
- `data-*` and `aria-*` attributes.

**May not write:**
1. A colour literal of any kind: `#…`, `rgb(`, `rgba(`, `hsl(`, `oklch(`, `oklab(`, a named colour, or a Tailwind palette colour (`bg-white`, `text-purple-500`).
2. An arbitrary value in brackets other than `[var(--layout-*)]`. That covers `text-[…]`, `w-[76px]`, `bg-[var(--c-…)]` and `[mask-image:…]`.
   A ground utility (`p-bg`, `p-sunken`, `p-sidebar`, `p-surface`, `p-fill`, `p-hover`, `p-selected`, `p-card-hover`, `p-row-hover`, `p-accent-bg`) is rule 2 by another name: a ground comes from the component that draws the box, row or state (`Card`, `Group`, `Pressable`, `Row`, `Choices`).
3. Any `text-{xs,sm,base,lg,xl,…}`, `font-{weight}`, `leading-*` or `tracking-*` utility.
4. Any `rounded*`, `shadow*`, `ring*`, `outline-*` (other than `outline-none` inside `ui/`) or `border-{color}` utility.
5. Spacing units 0.5, 1.5, 2.5, 3.5, 7, 9, 10, 11, 14, or any unit above 16.
6. The elements `<button>`, `<input>`, `<select>`, `<textarea>` or `<dialog>`. Use `Button`/`IconButton`/`Pressable`, `TextInput`/`TextArea`/`Select`/`Check`/`Switch` and `Dialog`. `Pressable` is the one unstyled clickable for a whole row or tile: a `<button>` with focus ring and hover from `ui/`.
7. The class strings `p-card`, `p-group`, `p-btn*`, `p-notice-*`, `p-button*`, `p-display`, `p-heading`, `p-eyebrow`, `p-label*`, `p-annotation`, `p-meta`, `p-row-text`, `p-title` and `p-t-*`. Use the component or the `t-*` role.
8. An import from `@cloudflare/kumo` or `@cloudflare/kumo/primitives`.
9. A second implementation of anything in §2. A review flags it, and the gate catches its symptoms through rules 1–7.

### 4.2 `components/ui/`
**May** use everything in 4.1, plus:
- arbitrary values that name a token (`[var(--c-…)]`, `[var(--r-…)]`, `[var(--shadow-…)]`, `[var(--dur-…)]`)
- spacing units 0.5 and 1.5
- Kumo imports
- the `ui` classes in `index.css`

**May not** use a colour literal or a size outside §1.3–1.5.

### 4.3 `index.css` and `theme.ts`
- **`theme.ts`** is the only file with colour literals, shadow colours and radius values.
- **`index.css`** may only:
  - map tokens into Tailwind's theme and Kumo's `--color-kumo-*` bridge
  - define `t-*` roles and `ui` component classes, from tokens
  - hold the `--layout-*` and `--dur-*` constants

  It may not contain a colour literal, a `font-size` outside the role table, or a `border-radius` outside the radius tokens. Today's 11 colour literals, 25 font sizes and 20 radii move or go.

---

## 5. The "design system" frame for the mockup
Add `?frame=system` to the gallery.
- Every section renders in a **2×2 grid of the four looks**: Graphite light, Graphite dark, Warm light, Warm dark, each quadrant scoped by `data-theme` and `data-mode`. The owner approves the system in one screen per section.
- Every number printed on the frame (hex, ratio, px) is **read from the live computed style**, not typed in. The frame then cannot drift from the code.

1. **Grounds:** the 7 ground swatches as stacked cards, each labelled with role, hex and ratio against `--c-bg`. Interaction: hover, pressed, selected, each on bg and on surface.
2. **Lines:** border, border-strong, field-border, dash, button-line, each as a 1 px rule on bg and surface, with its ratio.
3. **Text:** text, text-2, text-3, accent-fg on every ground (bg, sidebar, sunken, surface, field, fill, overlay, hover, selected), with the measured ratio and a pass/fail against its floor.
4. **Accent and status:** the accent fill with accent-on text; the focus ring on bg and surface. Each status as ink, tint, `Status`, `Chip`, `Notice` and danger-on on danger.
5. **Type:** each role from §1.3 as a specimen line: role name, size/line/weight/tracking, and the sample "Kinu ships what you ask for — 0123456789". Plus a chat paragraph and a code block.
6. **Spacing, radii, elevation, motion:**
   - the spacing scale as bars
   - the six radii on a 64 px square
   - the elevation levels as cards
   - three motion demos: hover a row, open a menu, fold a disclosure, each labelled with its token
7. **Buttons:** 5 variants × md and sm × rest, hover, active, focus-visible, disabled and busy, with icon-only versions. (Hover, active and focus are forced with `data-state` attributes so they show at rest.)
8. **Inputs:**
   - TextInput, TextArea and Select at md and sm, each rest, hover, focus, invalid (with error) and disabled
   - Field stacked and inline
   - Checkbox, Radio and Switch in every state, Switch with its label
   - Segmented with 2, 3 and 4 text segments and with icon segments
   - Tabs
9. **Status set:** Status in six tones, Chip neutral and tone with remove, Badge neutral, accent and on-picture, Avatar at 20/24/32, WorkspaceLogo, ChatMascot.
10. **Rows and groups:**
    - Row connected (status + ⋯), addable (+), device (Sandbox switch + grant chips), selected
    - a Group of four rows
    - Row on phone width
    - Menu open with a danger item
11. **Cards and tiles:** a Card with label and actions; Tile with Capture, Typeset with logo, Typeset with mascot and Typeset with badge, each at rest and hover; the grid at 1088 width.
12. **Page kinds:**
    - the frame page header (plain, with back, with actions)
    - the ToolBar (Mail's and Drive's)
    - the ChatBar in Focus (no rule, fade) and in Workbench (tabs, rule)
    - the FlowCard
13. **Overlays:** SaveBar in each state; Dialog (form, confirm, destructive); Popover; Tooltip; Toast in four tones; Empty; Loader and Skeleton; Meter at 40%, 85% and 100%; Table; CopyField.

---

## 6. Order of work
1. **`theme.ts`:**
   - add the new roles: `focus`, `danger-on`, `pressed`, the button set, `ILLUSTRATION`
   - rename `neutral-tint`→`hover`, `accent-subtle`→`selected`, `recessed`→`sunken`, `input-*`→`field-*`
   - delete `text-4`, `elevated` and `code`
   - change Warm dark `--c-border` to `#302920`
   - set the radii to §1.5
   - update `palette-ux.test.ts` to the §1.1 floors
2. **`index.css`:**
   - add the `t-*` roles; delete the old `p-*` type classes and the dead `p-btn*`
   - move the 11 literals out
   - collapse durations to the three tokens
   - add the `--layout-*` constants
   - remove the Tailwind radius remap
3. **`components/ui/`:** build the missing wrappers (§2 rows marked new or Kumo-based): Field, Select, Check, Tabs, Chip, Badge, Row, Group, Menu, Card, FlowCard, SaveBar, Dialog, Popover, Tooltip, Toast, Notice, Empty, Meter, Table, CopyField, Pressable.
4. **The gate:** `tests/design-system.test.ts` lands once the migration has every count at zero.
5. **Migrate by area, top offenders first** (§3.3): Drive, workspace settings, Models, Explore blueprint, Sidebar, then surfaces and plan-review. Each area lands with its debt at zero.
6. **Ship `?frame=system`** for the owner's approval of the system as a whole, beside the whole-app frame.
