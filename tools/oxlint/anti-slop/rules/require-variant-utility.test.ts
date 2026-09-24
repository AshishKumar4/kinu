import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuleTester } from "oxlint/plugins-dev";

import { requireVariantUtilityRule } from "./require-variant-utility.ts";

// A package with its own stylesheet, as the rule finds it: `packages/<name>/src/index.css`.
const root = mkdtempSync(join(tmpdir(), "kinu-scratch-require-variant-utility-"));
const source = join(root, "packages", "web", "src");
mkdirSync(source, { recursive: true });
const stylesheet = join(source, "index.css");
writeFileSync(stylesheet, `
/* .p-commented { color: red } is not a declaration */
@utility p-lift { translate: 0 -1px; }
@utility p-twice { color: var(--ink); }
@layer components {
  .p-plain { color: var(--ink); }
  .p-twice { color: var(--muted); }
  .p-card, .p-card-header { padding: 1rem; }
}
`);

const product = join(source, "Card.tsx");

try {
  new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } }).run(
    "anti-slop/require-variant-utility", requireVariantUtilityRule, {
      valid: [
        { filename: product, code: "const Card = () => <div className=\"p-plain hover:p-lift focus-visible:p-lift\" />;" },
        // Tailwind's padding scale is not a design class.
        { filename: product, code: "const Card = () => <div className=\"hover:p-4 md:p-[3px] focus:p-px\" />;" },
        { filename: product, code: "const classes = `${base} group-hover:p-lift`;" },
        // A stylesheet the package does not have governs nothing; neither does a test.
        { filename: join(root, "packages", "other", "src", "Card.tsx"), code: "const c = 'hover:p-plain';" },
        { filename: join(root, "packages", "web", "tests", "card.test.tsx"), code: "const c = 'hover:p-plain';" },
      ],
      invalid: [
        {
          name: "a variant of a plain components rule emits nothing",
          filename: product,
          code: "const Card = () => <div className=\"p-plain hover:p-plain\" />;",
          errors: [{ messageId: "variantOnPlainRule", data: { token: "hover:p-plain", name: "p-plain", stylesheet } }],
        },
        {
          name: "a stacked variant in a template",
          filename: product,
          code: "const classes = `md:hover:p-card ${extra}`;",
          errors: [{ messageId: "variantOnPlainRule", data: { token: "md:hover:p-card", name: "p-card", stylesheet } }],
        },
        {
          name: "an arbitrary variant keeps its inner colon",
          filename: product,
          code: "const c = '[&:hover]:p-card-header';",
          errors: [{ messageId: "variantOnPlainRule", data: { token: "[&:hover]:p-card-header", name: "p-card-header", stylesheet } }],
        },
        {
          name: "a class the stylesheet commented out is not declared",
          filename: product,
          code: "const c = 'hover:p-commented';",
          errors: [{ messageId: "variantOnPlainRule", data: { token: "hover:p-commented", name: "p-commented", stylesheet } }],
        },
        {
          name: "a class with two homes is reported at each use",
          filename: product,
          code: "const c = 'p-twice';",
          errors: [{ messageId: "twoHomes", data: { name: "p-twice", stylesheet } }],
        },
      ],
    },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
