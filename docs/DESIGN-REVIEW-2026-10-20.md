# The expert design review of 2026-10-20, and where each finding stands

On 2026-10-20 the owner asked for an expert review of the whole app's design ("linear figma etc level polish"). An expert
lane (HurtEarthworm) reviewed the whole-app mockup, which draws the real product components over typed fixtures, in
three passes:

- `REVIEW.md` covered the first build. It had findings F1–F21 and ended with a top ten.
- `REREVIEW.md` covered round one.
- `REREVIEW-2.md` covered round two (`design/whole-app` `aba14b1ee`). It added the owner's four notes as specs
  (A1–A4), four deviations (D1–D4) and new findings (N1–N12).

Its system section became `docs/DESIGN-SYSTEM.md`, which `tests/design-system.test.ts` now enforces. This file records
every finding the passes left open, so that none rests only in the lane's scratch notes. All the commits it cites are
on next-rc.

## Built

| Finding | What | Where |
|---|---|---|
| F1, F2, F4 | One page frame; the page top and Settings' header; one tile grid and size | `1ed1ff975` |
| F3, F5 | Typeset covers for tiles without a capture; no mesh behind the chat | `1ed1ff975` |
| F11, F15–F18, N1, N2, N4, N7, N8 | Plugins; toggles and nav rows; the Models save bar; Secrets; the Explore badge; header action heights; the phone double rule; one control radius | round two, `aba14b1ee` |
| A1 | No hairline under a chat-only bar (Home, Focus layout): what scrolls under it fades out | `e828d883b` |
| A2 | Mail and Drive under one compact tool bar (`ToolPage`) | `e828d883b` |
| A3, N5 | Plugins' and Devices' rows on one grid, with statuses on one x (`ui/Row`) | `e828d883b` |
| A4, F7 | One button set: its fill, line, shadow, focus and danger-on tokens, and no press scale | `e828d883b`; the design system moved the last callers |
| D1, N3 | Home's tile wears the assistant's mascot | `e38dfd62f` |
| D2 | One `ui/SaveBar` for every form | `e38dfd62f` |
| D4 | A device's grants are `Chip`s with their own revoke | `e828d883b` |
| N9 | Typeset covers ground on `--c-fill`, so a dark one is no hole | `e38dfd62f` |
| N10 | On a phone, a device row's status and switch take a second line under its name | `f9eee430e` |
| N11, F13 | Explore's sort is the system's `Choice`, not a native select | `e38dfd62f` |
| N12 | Workspace settings: the address is a field, one `Segmented` size, approval is a `Segmented` | `e38dfd62f` |
| F12 | The Explore blueprint on `Page` | `e38dfd62f` |
| F9 | Providers' boxes are rows of one `Group`, no card in a card | `dab03a728` |
| F6 | Copy, pass three: no line describing a theme, Sound, a role's Instructions or Web search's fallback order | this change |
| F8 | Drive's section headings are the system's label (`t-label`) | this change |

## Kept as they are, and why

- **F6, the rest.** Some lines the review listed say something a person needs, so they stay:
  - Computer size's "Applies the next time a computer starts." (when a change takes effect);
  - workspace settings' Clear history and Export lines (what a destructive or sensitive action keeps);
  - Secrets' and Invite's terms (who can use a value, and for how long).
- **F8, "Also from Kinu".** It names its rows inside its panel, because the panel stands beside the featured tile and
  a label above it would drop its top below the tile's. The owner approved Explore on 2026-10-21.
- **D3 and F19, the two flows' buttons and titles.** Self-deploy is a public page. The owner decided that public pages
  use the public type variants and the 38 `lg` button (2026-10-21). Onboarding is inside the app, so it keeps the
  app's sizes.
- **F20, `/new`'s own prompt.** A new chat opens on the prompt card the owner approved, with "no field behind chat; a
  quiet one on New workspace that rests" (`31e2a1de2`). Inside a chat it is the composer.

## Open

- **N6, captures in both modes.** A slate's capture is taken in one mode, so a light capture stands out in dark and a
  dark one in light. Every capture sits on a recessed mat, which frames it. Capturing each slate in both modes needs
  the capture pipeline to shoot twice, and stays open.
