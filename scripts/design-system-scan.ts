/**
 * The design system's gate (docs/DESIGN-SYSTEM.md §4): what page, feature and `ui/` code may write, read off the
 * TypeScript AST of `packages/cf-backend/src`, and what `index.css` may hold. Each finding names its file, line, rule
 * and the token that broke it. `tests/design-system.test.ts` holds the count at zero; run directly, this prints the
 * findings by file and by rule (`bun scripts/design-system-scan.ts [--files] [path…]`).
 *
 * Out of scope, as the §3 audit set it: the design gallery (`gallery*`, `diff-design/`), the landing page's own frame
 * (`components/landing/`), and tests.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Node } from 'oxc-parser';
import postcss from 'postcss';
import { parse, walk } from './syntax';
import type { SyntaxNode } from './syntax';

export type DesignRule =
  | 'colour-literal' | 'arbitrary-value' | 'type-utility' | 'box-utility' | 'off-scale-spacing'
  | 'raw-element' | 'legacy-class' | 'ground-utility' | 'kumo-import' | 'inline-style' | 'css-colour' | 'css-font-size' | 'css-radius';

export interface DesignFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: DesignRule;
  readonly token: string;
}

const ROOT = join(import.meta.dirname, '..', 'packages', 'cf-backend', 'src');

const OUT_OF_SCOPE = [/^gallery/u, /^diff-design\//u, /^components\/landing\//u, /\.test\.tsx?$/u];

/** Spacing units the scale allows (§1.4); `ui/` may also use 0.5 and 1.5. */
const SPACING_UNITS = new Set(['0', 'px', '1', '2', '3', '4', '5', '6', '8', '12', '16']);

const UI_SPACING_UNITS = new Set([...SPACING_UNITS, '0.5', '1.5']);

const SPACING = /^-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|bottom|left|right|start|end)-(\d+(?:\.\d+)?|px)$/u;

const TYPE_UTILITY = /^(?:text-(?:xs|sm|base|lg|xl|[2-9]xl)|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|leading-.+|tracking-.+)$/u;

/** A radius, lift, ring or outline, or a border's colour: a border's sides, widths and styles are layout. */
const BOX_UTILITY = /^(?:rounded(?:-.+)?|shadow(?:-.+)?|ring(?:-.+)?|outline-.+|border-(?!(?:[tblrxyse]-)?\d+$|[tblrxyse]$|solid$|dashed$|dotted$|double$|none$|hidden$|collapse$|separate$|spacing).+)$/u;

const PALETTE = /^(?:bg|text|border|fill|stroke|from|to|via|decoration|accent|caret|divide|placeholder)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d+)?$/u;

const LEGACY = /^p-(?:card|group|btn(?:-.+)?|notice-.+|button(?:-.+)?|display|heading|eyebrow|label(?:-.+)?|annotation|meta|row-text|title|t-.+)$/u;

/** A ground: feature code gets one from the component that draws the box, row or state, never as a class (§4.1). */
const GROUND = /^p-(?:bg|sunken|sidebar|surface|fill|hover|selected|card-hover|row-hover|accent-bg)$/u;

const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/u;

const FUNCTION_COLOUR = /\b(?:rgba?|hsla?|oklch|oklab)\(/u;

const RELATIVE_COLOUR = /\b(?:rgba?|hsla?|oklch|oklab)\(from\b/gu;

/** What an arbitrary value may name: a layout constant anywhere; in `ui/`, any token. */
const LAYOUT_VALUE = /^\[var\(--layout-[\w-]+\)\]$/u;

const TOKEN_VALUE = /^\[var\(--(?:layout|c|r|shadow|dur)-[\w-]+\)\]$/u;

/** An attribute selector alone (`[data-note-row]`, a string handed to `closest`): no class at all. */
const SELECTOR = /^\[[\w-]+(?:="[^"]*")?\]$/u;

/** What `ui/` may write of the box utilities: the focus outline off a control it rings itself, an edge with no colour. */
const UI_BOX = new Set(['outline-none', 'border-transparent']);

const RAW_ELEMENTS = new Set(['button', 'input', 'select', 'textarea', 'dialog']);

/** `style` keys feature code may set, from data (§4.1). */
const STYLE_KEYS = new Set(['width', 'height', 'left', 'top', 'right', 'bottom', 'transform', 'gridTemplateColumns', 'maxHeight', 'minWidth', 'minHeight', 'maxWidth', 'aspectRatio']);

/** The role table's sizes (§1.3), in px. */
const ROLE_FONT_SIZES = new Set(['36px', '24px', '17px', '15.5px', '15px', '14px', '13px', '12px', '11px', '0.92em', 'inherit']);

/** Names a class list goes by when it is a constant rather than a `className`. */
const CLASS_NAME = /(?:cls|class|classes|style|tile|frame|rhythm|row|box|grid|pill|ring)$/iu;

/** A token with its variants (`sm:hover:`) and its important mark taken off. */
function bare(token: string): string {
  const parts = token.split(/:(?![^[]*\])/u);

  return (parts.at(-1) ?? token).replace(/^!/u, '');
}

function inScope(file: string): boolean {
  return !OUT_OF_SCOPE.some((pattern) => pattern.test(file));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesUnder(path);

    return /\.tsx?$/u.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The rules a class token breaks, in feature code or in `ui/`. */
function classRules(token: string, ui: boolean): DesignRule[] {
  const name = bare(token);
  const broken: DesignRule[] = [];

  if (PALETTE.test(name)) broken.push('colour-literal');

  const bracket = /\[[^\]]*\]/u.exec(name);

  if (bracket !== null && !SELECTOR.test(name) && !(ui ? TOKEN_VALUE : LAYOUT_VALUE).test(bracket[0])) broken.push('arbitrary-value');

  if (bracket === null && TYPE_UTILITY.test(name)) broken.push('type-utility');

  if (bracket === null && BOX_UTILITY.test(name) && !(ui && UI_BOX.has(name))) broken.push('box-utility');

  const spacing = SPACING.exec(name);

  if (spacing !== null && bracket === null && !(ui ? UI_SPACING_UNITS : SPACING_UNITS).has(spacing[1] ?? '') && !/^(?:auto|full|1\/2|1\/3|2\/3|1\/4|3\/4)$/u.test(spacing[1] ?? '')) {
    broken.push('off-scale-spacing');
  }

  if (!ui && LEGACY.test(name)) broken.push('legacy-class');

  if (!ui && GROUND.test(name)) broken.push('ground-utility');

  return broken;
}

/** Whether a string is a class list: what a `className` holds, or a constant named as one, or utilities through and through. */
function looksLikeClasses(text: string, named: boolean): boolean {
  const tokens = text.trim().split(/\s+/u).filter((token) => token !== '');

  if (tokens.length === 0 || /[A-Z]/u.test(text.replace(/\[[^\]]*\]/gu, ''))) return false;

  if (named) return true;

  const utilities = tokens.filter((token) => /[-:[]/u.test(token) || /^(?:flex|grid|block|hidden|truncate|relative|absolute|fixed|sticky|border|rounded|shadow|italic|underline|uppercase|contents|inline|grow|shrink)$/u.test(token));

  return tokens.length >= 2 && utilities.length / tokens.length >= 0.75;
}

/** The name a declaration, key, attribute or callee goes by; '' for anything computed. */
function nameOf(raw: Node | null | undefined): string {
  if (raw === null || raw === undefined) return '';

  if (raw.type === 'Identifier' || raw.type === 'JSXIdentifier') return raw.name;

  if (raw.type === 'Literal') return typeof raw.value === 'string' ? raw.value : '';

  return raw.type === 'MemberExpression' ? nameOf(raw.property) : '';
}

/** Whether a string sits in a `className`, in a `buttonClass`-style call, or in a constant named as a class list. */
function namedAsClasses(node: SyntaxNode): boolean {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    const raw = at.raw;

    if (raw.type === 'JSXAttribute') return nameOf(raw.name) === 'className';

    if (raw.type === 'VariableDeclarator') return CLASS_NAME.test(nameOf(raw.id));

    if (raw.type === 'Property') return CLASS_NAME.test(nameOf(raw.key));

    if (raw.type === 'CallExpression' && /(?:class|cls|cn|clsx)$/iu.test(nameOf(raw.callee))) return true;

    if (raw.type === 'BlockStatement' || raw.type === 'Program') return false;
  }

  return false;
}

/** Whether a string literal is a module's name, not a value. */
function isModuleName(node: SyntaxNode): boolean {
  const parent = node.parent?.raw.type;

  return parent === 'ImportDeclaration' || parent === 'ExportNamedDeclaration' || parent === 'ExportAllDeclaration' || parent === 'ImportExpression';
}

/** The `style` object's keys a JSX attribute sets, each with its node. */
function styleKeys(raw: Node): readonly { readonly node: Node; readonly key: string }[] {
  if (raw.type !== 'JSXAttribute' || nameOf(raw.name) !== 'style' || raw.value?.type !== 'JSXExpressionContainer') return [];

  const expression = raw.value.expression;

  if (expression.type !== 'ObjectExpression') return [];

  return expression.properties.map((property) => ({ node: property, key: property.type === 'Property' ? nameOf(property.key) : '…' }));
}

function scanSource(file: string, text: string): DesignFinding[] {
  const ui = file.startsWith('components/ui/');
  const { root, lineAt } = parse(file, text);
  const findings: DesignFinding[] = [];
  const add = (start: number, rule: DesignRule, token: string) => findings.push({ file, line: lineAt(start), rule, token });

  const strings = (node: SyntaxNode, value: string) => {
    // A hex with a digit, or six or eight long: `#add` is an anchor's word, `#1a1a1a` a colour.
    for (const match of value.match(new RegExp(HEX, 'gu')) ?? []) if (/[0-9]/u.test(match) || match.length >= 7) add(node.start, 'colour-literal', match);

    // `oklch(from …)` makes a colour out of another one (a syntax theme's, a token's): relative, not a literal.
    const literal = value.replace(RELATIVE_COLOUR, '');

    if (FUNCTION_COLOUR.test(literal)) add(node.start, 'colour-literal', FUNCTION_COLOUR.exec(literal)?.[0] ?? '');

    if (!looksLikeClasses(value, namedAsClasses(node))) return;

    for (const token of value.trim().split(/\s+/u)) for (const rule of classRules(token, ui)) add(node.start, rule, token);
  };

  walk(root, (node) => {
    const raw = node.raw;

    if (raw.type === 'Literal' && typeof raw.value === 'string' && !isModuleName(node)) strings(node, raw.value);

    if (raw.type === 'TemplateLiteral') strings(node, raw.quasis.map((quasi) => quasi.value.cooked ?? '').join(' '));

    if (raw.type === 'ImportDeclaration' && !ui && /^@cloudflare\/kumo(?:\/|$)/u.test(nameOf(raw.source))) add(node.start, 'kumo-import', nameOf(raw.source));

    if (raw.type === 'JSXOpeningElement' && !ui && RAW_ELEMENTS.has(nameOf(raw.name))) add(node.start, 'raw-element', `<${nameOf(raw.name)}>`);

    if (!ui) for (const { node: property, key } of styleKeys(raw)) if (!STYLE_KEYS.has(key) && !key.startsWith('--')) add(property.start, 'inline-style', key);
  });

  return findings;
}

/** A `font` shorthand's size: the one length before its `/` line height. */
const FONT_SIZE = /^([\d.]+(?:px|em|rem))(?:\/|$)/u;

/** A radius that is only tokens and square corners, or none. */
const RADIUS_TOKENS = /^(?:(?:var\(--r-[\w-]+\)|0)\s*)+$|^inherit$/u;

/** A named size variant (§1.3) and the one value the role table gives it. */
const SIZE_VARIANTS: ReadonlyMap<string, string> = new Map([
  ['--t-chat-heading-1', '22px'], ['--t-chat-heading-2', '19px'], ['--t-chat-heading-3', '17px'],
  ['--t-chat-heading-workbench-1', '1.1em'], ['--t-chat-heading-workbench-2', '1.05em'], ['--t-chat-heading-workbench-3', '1em'],
  ['--t-code-workbench', '12.5px'], ['--t-workspace-tab', '13.5px'], ['--t-field-touch', 'max(16px, 1em)'],
  ['--t-public-body', '15px'], ['--t-public-lede', '17px'], ['--t-public-control', '14px'], ['--t-wordmark', '18px'],
  ['--t-hero', 'clamp(38px, 4vw, 46px)'], ['--t-hero-chat', 'clamp(28px, 3.4vw, 40px)'],
]);

/** A size that is a variant's name. */
const SIZE_VARIANT = /^var\((--t-[\w-]+)\)$/u;

/** A colour made from a token, `oklch(from var(--c-…) …)`: relative to the system's own value, not a literal. */
const FROM_TOKEN = /\b(?:rgba?|hsla?|oklch|oklab)\(from var\(--[\w-]+\)/gu;

/** `index.css` (§4.3), read by postcss: no colour literal, no font size outside the role table, no radius but a token. */
function scanCss(text: string): DesignFinding[] {
  const findings: DesignFinding[] = [];

  postcss.parse(text).walkDecls((decl) => {
    const add = (rule: DesignRule, token: string) => findings.push({ file: 'index.css', line: decl.source?.start?.line ?? 0, rule, token });

    for (const match of decl.value.match(new RegExp(HEX, 'gu')) ?? []) add('css-colour', match);

    const literal = decl.value.replace(FROM_TOKEN, '');

    if (FUNCTION_COLOUR.test(literal)) add('css-colour', FUNCTION_COLOUR.exec(literal)?.[0] ?? '');

    if (decl.prop.startsWith('--t-') && SIZE_VARIANTS.get(decl.prop) !== decl.value) add('css-font-size', `${decl.prop}: ${decl.value}`);

    const variant = SIZE_VARIANT.exec(decl.value)?.[1];

    if (decl.prop === 'font-size' && !ROLE_FONT_SIZES.has(decl.value) && (variant === undefined || !SIZE_VARIANTS.has(variant))) add('css-font-size', decl.value);

    if (decl.prop === 'font') {
      const size = decl.value.split(/\s+/u).map((part) => FONT_SIZE.exec(part)?.[1]).find((found) => found !== undefined);

      if (size !== undefined && !ROLE_FONT_SIZES.has(size)) add('css-font-size', size);
    }

    if (/^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/u.test(decl.prop) && !RADIUS_TOKENS.test(decl.value)) add('css-radius', decl.value);
  });

  return findings;
}

export function scanDesignSystem(only: readonly string[] = []): DesignFinding[] {
  const files = filesUnder(ROOT).map((path) => relative(ROOT, path)).filter(inScope)
    .filter((file) => only.length === 0 || only.some((prefix) => file.startsWith(prefix)));

  const css = only.length === 0 || only.includes('index.css') ? scanCss(readFileSync(join(ROOT, 'index.css'), 'utf8')) : [];

  return [...files.flatMap((file) => scanSource(file, readFileSync(join(ROOT, file), 'utf8'))), ...css];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const findings = scanDesignSystem(args.filter((arg) => !arg.startsWith('--')));

  const count = (key: (finding: DesignFinding) => string): [string, number][] => {
    const tally = new Map<string, number>();

    for (const finding of findings) tally.set(key(finding), (tally.get(key(finding)) ?? 0) + 1);

    return [...tally].sort((a, b) => b[1] - a[1]);
  };

  if (args.includes('--list')) for (const finding of findings) console.log(`${finding.file}:${String(finding.line)} ${finding.rule} ${finding.token}`);

  console.log(`total ${String(findings.length)}`);

  for (const [rule, n] of count((finding) => finding.rule)) console.log(`  ${rule} ${String(n)}`);

  if (args.includes('--files')) for (const [file, n] of count((finding) => finding.file)) console.log(`${String(n).padStart(5)} ${file}`);
}
