import { RuleTester } from "oxlint/plugins-dev";

import { noTuiColourLiteralRule } from "./no-tui-colour-literal.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });
const pane = "/repo/packages/cli/src/tui/messages.tsx";

tester.run("anti-slop/no-tui-colour-literal", noTuiColourLiteralRule, {
  valid: [
    { filename: pane, code: "const Note = () => <text fg={theme.colors.text.muted}>note</text>;" },
    { filename: pane, code: "const box = { borderColor: theme.colors.border.subtle };" },
    // Not a colour key, and not a whole colour name.
    { filename: pane, code: "const Tab = () => <text id=\"red\" fg={roles.redBright}>tab</text>;" },
    { filename: pane, code: "const label = 'issue #123456a';" },
    // The registry is where the literals live.
    { filename: "/repo/packages/cli/src/tui/theme.ts", code: "export const dark = { text: { strong: '#E6E6E6' }, fg: 'white' };" },
    // Outside the TUI the rule has nothing to say.
    { filename: "/repo/packages/cf-backend/src/components/Card.tsx", code: "const Card = () => <div color=\"red\" style={{ color: '#FF0000' }} />;" },
  ],
  invalid: [
    {
      name: "a hex colour in a JSX prop",
      filename: pane,
      code: "const Note = () => <text fg=\"#A0A0A0\">note</text>;",
      errors: [{ messageId: "hexColour", data: { literal: "#A0A0A0" } }],
    },
    {
      name: "a hex colour inside a template",
      filename: pane,
      code: "const style = `color: #00FF00;`;",
      errors: [{ messageId: "hexColour", data: { literal: "#00FF00" } }],
    },
    {
      name: "a named colour on a paint prop",
      filename: pane,
      code: "const Warn = () => <text fg=\"yellow\">careful</text>;",
      errors: [{ messageId: "namedColour", data: { key: "fg", colour: "yellow" } }],
    },
    {
      name: "a named colour in an expression container",
      filename: pane,
      code: "const Warn = () => <box backgroundColor={'black'} />;",
      errors: [{ messageId: "namedColour", data: { key: "backgroundColor", colour: "black" } }],
    },
    {
      name: "a named colour in a style object",
      filename: "/repo/packages/cli/src/tui/status-bar.tsx",
      code: "const bar = { borderColor: 'Grey' };",
      errors: [{ messageId: "namedColour", data: { key: "borderColor", colour: "Grey" } }],
    },
  ],
});
