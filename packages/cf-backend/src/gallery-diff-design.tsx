import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { UIMessage } from "ai";
import { GaugeIcon } from "@phosphor-icons/react";
import {
  diffLines, fileDiff, inNoteOrder, parseGitDiff, type ChangeNotesCard, type ChangeSet, type DiffAnchor, type FileDiff, type FileStatus,
  type ReviewAnnotation, type TurnLiveness,
} from "@kinu.run/core";
import Layout from "@/components/layout";
import { WorkspaceBar } from "@/components/WorkspaceBar";
import { SubordinateTabs } from "@/components/SubordinateTabs";
import { MessageView } from "@/components/MessageView";
import { Composer, type ChatMode } from "@/components/Composer";
import { ModelPicker } from "@/components/ModelPicker";
import { tabCls, tabStripH } from "@/components/ui/form";
import { ChangesPanel, LAYOUT_KEY } from "@/components/surfaces/changes/ChangesPanel";
import { ReviewBar } from "@/diff-design/ReviewBar";
import { FeedbackCard } from "@/components/surfaces/changes/FeedbackCard";
import { NotesProvider, noteOf, type NotesStore, type OpenDraft } from "@/components/surfaces/changes/notes-provider";
import { AnnotationType } from "@plannotator/ui/types";

const WORKSPACE = "checkout-fixes";

const NOW = new Date(2026, 8, 23, 16, 5).getTime();

function snapshot(path: string, status: FileStatus, before: string, after: string): FileDiff {
  return fileDiff(path, status, diffLines(before, after));
}

const lines = (...rows: string[]): string => rows.join("\n");

const APPLY_BEFORE = lines(
  'import type { Cart, Coupon } from "./types";',
  'import { rules } from "./rules";',
  'import { roundCents } from "../lib/money";',
  'import { formatDate } from "../lib/dates";',
  "",
  "export class CouponError extends Error {",
  "  constructor(readonly code: string, message: string) {",
  "    super(message);",
  "  }",
  "}",
  "",
  "/** A code is six to twelve letters or digits; anything else never reaches the rules. */",
  "export function validCode(code: string): boolean {",
  "  return /^[A-Z0-9]{6,12}$/.test(code);",
  "}",
  "",
  "/** A coupon applies once per cart; a second apply is a no-op. */",
  "export function applyCoupon(cart: Cart, coupon: Coupon): Cart {",
  "  if (cart.coupons.includes(coupon.code)) return cart;",
  "",
  "  if (coupon.expiresAt !== null && coupon.expiresAt < Date.now()) {",
  "    throw new CouponError(\"expired\", `Coupon ${coupon.code} has expired`);",
  "  }",
  "",
  "  const rule = rules[coupon.kind];",
  "  const discount = rule.percent",
  "    ? cart.subtotal * (coupon.value / 100)",
  "    : coupon.value;",
  "",
  "  return {",
  "    ...cart,",
  "    coupons: [...cart.coupons, coupon.code],",
  "    discount: roundCents(cart.discount + discount),",
  "    total: roundCents(cart.subtotal - cart.discount - discount),",
  "  };",
  "}",
  "",
  "export function removeCoupon(cart: Cart, code: string): Cart {",
  "  if (!cart.coupons.includes(code)) return cart;",
  "",
  "  return {",
  "    ...cart,",
  "    coupons: cart.coupons.filter((each) => each !== code),",
  "  };",
  "}",
  "",
  "/** Stacking is decided per rule: a fixed coupon stacks, a percentage one does not. */",
  "export function stacks(cart: Cart, coupon: Coupon): boolean {",
  "  return cart.coupons.length === 0 || rules[coupon.kind].stackable;",
  "}",
  "",
  "export function expiresLabel(coupon: Coupon): string {",
  "  return coupon.expiresAt === null ? \"Never expires\" : `Expires ${formatDate(coupon.expiresAt)}`;",
  "}",
  "",
  "export function describeCoupon(coupon: Coupon): string {",
  "  const rule = rules[coupon.kind];",
  "",
  "  return rule.percent ? `${coupon.value}% off` : `$${coupon.value} off`;",
  "}",
);

const APPLY_AFTER = lines(
  'import type { Cart, Coupon, CouponKind } from "./types";',
  'import { rules } from "./rules";',
  'import { roundCents } from "../lib/money";',
  'import { formatDate } from "../lib/dates";',
  "",
  "export class CouponError extends Error {",
  "  constructor(readonly code: string, message: string) {",
  "    super(message);",
  "  }",
  "}",
  "",
  "/** A code is six to twelve letters or digits; anything else never reaches the rules. */",
  "export function validCode(code: string): boolean {",
  "  return /^[A-Z0-9]{6,12}$/.test(code);",
  "}",
  "",
  "/** A coupon applies once per cart; a second apply is a no-op. */",
  "export function applyCoupon(cart: Cart, coupon: Coupon): Cart {",
  "  if (cart.coupons.includes(coupon.code)) return cart;",
  "",
  "  if (coupon.expiresAt !== null && coupon.expiresAt < Date.now()) {",
  "    throw new CouponError(\"expired\", `Coupon ${coupon.code} expired on ${formatDate(coupon.expiresAt)}`);",
  "  }",
  "",
  "  const rule = rules[kindOf(coupon)];",
  "  const discount = rule.percent",
  "    ? cart.subtotal * (Math.min(coupon.value, rule.maxPercent) / 100)",
  "    : coupon.value;",
  "",
  "  return {",
  "    ...cart,",
  "    coupons: [...cart.coupons, coupon.code],",
  "    discount: roundCents(cart.discount + discount),",
  "    total: roundCents(cart.subtotal - cart.discount - discount),",
  "  };",
  "}",
  "",
  "export function removeCoupon(cart: Cart, code: string): Cart {",
  "  if (!cart.coupons.includes(code)) return cart;",
  "",
  "  return {",
  "    ...cart,",
  "    coupons: cart.coupons.filter((each) => each !== code),",
  "  };",
  "}",
  "",
  "/** Stacking is decided per rule: a fixed coupon stacks, a percentage one does not. */",
  "export function stacks(cart: Cart, coupon: Coupon): boolean {",
  "  return cart.coupons.length === 0 || rules[kindOf(coupon)].stackable;",
  "}",
  "",
  "export function expiresLabel(coupon: Coupon): string {",
  "  return coupon.expiresAt === null ? \"Never expires\" : `Expires ${formatDate(coupon.expiresAt)}`;",
  "}",
  "",
  "export function describeCoupon(coupon: Coupon): string {",
  "  const rule = rules[kindOf(coupon)];",
  "",
  "  return rule.percent ? `${coupon.value}% off` : `$${coupon.value} off`;",
  "}",
  "",
  "/** Rows written before migration 0042 carry no kind; their value column says which one they are. */",
  "function kindOf(coupon: Coupon): CouponKind {",
  "  return coupon.kind ?? (coupon.valuePercent === null ? \"fixed\" : \"percent\");",
  "}",
);

const RULES_BEFORE = lines(
  'import type { CouponKind } from "./types";',
  "",
  "export interface Rule {",
  "  readonly percent: boolean;",
  "  readonly stackable: boolean;",
  "}",
  "",
  "export const rules: Record<CouponKind, Rule> = {",
  "  fixed: { percent: false, stackable: true },",
  "  percent: { percent: true, stackable: false },",
  "};",
);

const RULES_AFTER = lines(
  'import type { CouponKind } from "./types";',
  "",
  "export interface Rule {",
  "  readonly percent: boolean;",
  "  readonly stackable: boolean;",
  "  /** A percentage above this is a data error, so it is clamped rather than charged. */",
  "  readonly maxPercent: number;",
  "}",
  "",
  "export const rules: Record<CouponKind, Rule> = {",
  "  fixed: { percent: false, stackable: true, maxPercent: 0 },",
  "  percent: { percent: true, stackable: false, maxPercent: 50 },",
  "};",
);

const MIGRATION_BEFORE = lines(
  "-- 0042: every coupon states its kind.",
  "ALTER TABLE coupons ADD COLUMN kind TEXT;",
  "",
  "UPDATE coupons SET kind = 'fixed' WHERE value_cents IS NOT NULL;",
);

const MIGRATION_AFTER = lines(
  "-- 0042: every coupon states its kind.",
  "ALTER TABLE coupons ADD COLUMN kind TEXT;",
  "",
  "UPDATE coupons SET kind = 'fixed' WHERE value_cents IS NOT NULL;",
  "UPDATE coupons SET kind = 'percent' WHERE value_percent IS NOT NULL;",
  "",
  "-- A row with neither value is a data error: stop here rather than guess.",
  "SELECT RAISE(ABORT, 'coupon without a kind') FROM coupons WHERE kind IS NULL;",
);

const TEST_AFTER = lines(
  'import { describe, expect, test } from "bun:test";',
  'import { applyCoupon, describeCoupon } from "../src/apply-coupon";',
  'import { cartOf, couponOf } from "./helpers";',
  "",
  "describe(\"coupons written before migration 0042\", () => {",
  "  test(\"SAVE20 with no kind applies as 20% off\", () => {",
  "    const cart = cartOf({ subtotal: 80 });",
  "    const coupon = couponOf({ code: \"SAVE20\", kind: null, valuePercent: 20 });",
  "",
  "    expect(applyCoupon(cart, coupon).total).toBe(64);",
  "  });",
  "",
  "  test(\"SAVE10 with no kind applies as $10 off\", () => {",
  "    const cart = cartOf({ subtotal: 80 });",
  "    const coupon = couponOf({ code: \"SAVE10\", kind: null, valueCents: 1000 });",
  "",
  "    expect(applyCoupon(cart, coupon).total).toBe(70);",
  "  });",
  "",
  "  test(\"a percentage above the rule's ceiling is clamped\", () => {",
  "    const cart = cartOf({ subtotal: 100 });",
  "    const coupon = couponOf({ code: \"TYPO90\", kind: \"percent\", valuePercent: 90 });",
  "",
  "    expect(applyCoupon(cart, coupon).total).toBe(50);",
  "  });",
  "",
  "  test(\"the label reads the inferred kind\", () => {",
  "    expect(describeCoupon(couponOf({ code: \"SAVE20\", kind: null, valuePercent: 20 }))).toBe(\"20% off\");",
  "  });",
  "});",
);

const LEGACY_BEFORE = lines(
  "/**",
  " * The discount path before coupons had rules. Nothing imports it since the",
  " * checkout moved to applyCoupon; it stays only so old carts can be priced.",
  " */",
  'import type { Cart } from "./types";',
  "",
  "export function legacyDiscount(cart: Cart, code: string): number {",
  "  switch (code) {",
  "    case \"WELCOME\":",
  "      return 5;",
  "    case \"SAVE10\":",
  "      return 10;",
  "    case \"SAVE20\":",
  "      return cart.subtotal * 0.2;",
  "    default:",
  "      return 0;",
  "  }",
  "}",
  "",
  "export function legacyTotal(cart: Cart, code: string): number {",
  "  return Math.max(0, cart.subtotal - legacyDiscount(cart, code));",
  "}",
);

const README_BEFORE = lines(
  "# checkout",
  "",
  "Prices a cart and applies coupons. `applyCoupon` is the only way a discount",
  "reaches a cart.",
  "",
  "## Coupons",
  "",
  "A coupon is fixed (`value_cents`) or a percentage (`value_percent`).",
  "",
  "## Tests",
  "",
  "Run `bun test packages/checkout`.",
);

const README_AFTER = lines(
  "# checkout",
  "",
  "Prices a cart and applies coupons. `applyCoupon` is the only way a discount",
  "reaches a cart.",
  "",
  "## Coupons",
  "",
  "A coupon is fixed (`value_cents`) or a percentage (`value_percent`), and its",
  "`kind` column says which. Rows written before migration 0042 have no kind;",
  "`applyCoupon` reads it from the value column instead.",
  "",
  "## Tests",
  "",
  "Run `bun test packages/checkout`.",
);

const COUPON_FILES: readonly FileDiff[] = [
  snapshot("packages/checkout/src/apply-coupon.ts", "changed", APPLY_BEFORE, APPLY_AFTER),
  snapshot("packages/checkout/src/rules.ts", "changed", RULES_BEFORE, RULES_AFTER),
  snapshot("packages/checkout/src/legacy-discount.ts", "removed", LEGACY_BEFORE, ""),
  snapshot("packages/checkout/migrations/0042_coupon_kind.sql", "changed", MIGRATION_BEFORE, MIGRATION_AFTER),
  snapshot("packages/checkout/tests/coupon-kind.test.ts", "added", "", TEST_AFTER),
  snapshot("packages/checkout/README.md", "changed", README_BEFORE, README_AFTER),
];

const COUPON_CHANGES: ChangeSet = {
  baseline: "snapshot 4f1c9a",
  source: "workspace", label: "Workspace", mode: "vfs-baseline", files: COUPON_FILES, trackedSince: NOW - 111 * 60e3,
};


const RUNBOOK = lines(
  "# Coupon incident runbook",
  "",
  ...Array.from({ length: 34 }, (_, index) => [
    `## Step ${String(index + 1)}`,
    "",
    index % 2 === 0
      ? "Check the coupon's kind and value columns before touching the cart."
      : "Re-run `bun test packages/checkout` and keep the output in the incident.",
    "",
  ]).flat(),
);

const OLD_CART = lines(
  'import type { Cart } from "./types";',
  "",
  ...Array.from({ length: 40 }, (_, index) => `export const OLD_RULE_${String(index)} = ${String(index * 5)};`),
);

const CSV_BEFORE = lines("id,code,kind,value", ...Array.from({ length: 1400 }, (_, index) => `${String(index)},SAVE${String(index % 50)},fixed,${String(index % 20)}`));

const CSV_AFTER = lines("id,code,kind,value", ...Array.from({ length: 1400 }, (_, index) => {
  const kind = index % 20 === 5 && index < 970 ? "percent" : "fixed";

  return `${String(index)},SAVE${String(index % 50)},${kind},${String(index % 20)}`;
}));

const EDGE_CHANGES: ChangeSet = {
  source: "workspace", label: "Workspace", mode: "vfs-baseline", trackedSince: NOW - 26 * 60 * 60e3,
  files: [
    { path: "packages/checkout/src/generated/schema.ts", status: "changed", added: 1214, removed: 1180, lines: [], truncated: true },
    { path: "data/exports/orders-2026.json", status: "changed", added: 0, removed: 0, lines: [], omitted: "large" },
    { path: "public/receipt-logo.png", status: "changed", added: 0, removed: 0, lines: [], omitted: "binary" },
    snapshot("data/seed/coupons.csv", "changed", CSV_BEFORE, CSV_AFTER),
    snapshot("docs/incident-runbook.md", "added", "", RUNBOOK),
    snapshot("packages/checkout/src/old-cart.ts", "removed", OLD_CART, ""),
  ],
};

const DEVICE_PATCH = [
  "diff --git a/src/app/checkout/page.tsx b/src/app/checkout/page.tsx",
  "index 3f2a1c0..9b8e7d2 100644",
  "--- a/src/app/checkout/page.tsx",
  "+++ b/src/app/checkout/page.tsx",
  "@@ -41,6 +41,9 @@ export default function CheckoutPage() {",
  "   const [code, setCode] = useState(\"\");",
  "   const cart = useCart();",
  "-  const total = cart.subtotal - cart.discount;",
  "+  const total = useMemo(",
  "+    () => cart.subtotal - cart.discount,",
  "+    [cart.subtotal, cart.discount],",
  "+  );",
  " ",
  "   return (",
  "     <main className=\"checkout\">",
  "@@ -88,6 +91,7 @@ function CouponField({ onApply }: { onApply: (code: string) => void }) {",
  "       <input",
  "         value={value}",
  "         onChange={(event) => setValue(event.target.value.toUpperCase())}",
  "+        aria-label=\"Coupon code\"",
  "       />",
  "       <button type=\"button\" onClick={() => onApply(value)}>Apply</button>",
  "     </form>",
  "diff --git a/public/receipt-logo.png b/public/receipt-logo.png",
  "index 1a2b3c4..5d6e7f8 100644",
  "Binary files a/public/receipt-logo.png and b/public/receipt-logo.png differ",
  "diff --git a/src/lib/format.ts b/src/lib/format.ts",
  "new file mode 100644",
  "index 0000000..a1b2c3d",
  "--- /dev/null",
  "+++ b/src/lib/format.ts",
  "@@ -0,0 +1,6 @@",
  "+export function money(cents: number): string {",
  "+  return new Intl.NumberFormat(\"en-US\", {",
  "+    style: \"currency\",",
  "+    currency: \"USD\",",
  "+  }).format(cents / 100);",
  "+}",
].join("\n");

const BLOG_PATCH = [
  "diff --git a/posts/launch.md b/posts/launch.md",
  "index 7c1d2e3..9f8a7b6 100644",
  "--- a/posts/launch.md",
  "+++ b/posts/launch.md",
  "@@ -1,3 +1,3 @@",
  " # Launch week",
  "-Checkout ships on Monday.",
  "+Checkout and coupons ship on Monday.",
  " ",
].join("\n");

/** Two repositories in the laptop's working folder, each a folder of the list. */
const DEVICE_CHANGES: ChangeSet = {
  source: "laptop", label: "laptop", mode: "git", baseline: "blog@9f8a7b6 shop@3f2a1c0", repositories: ["blog", "shop"],
  files: [
    ...parseGitDiff(BLOG_PATCH).map((file) => ({ ...file, path: `blog/${file.path}` })),
    ...parseGitDiff(DEVICE_PATCH).map((file) => ({ ...file, path: `shop/${file.path}` })),
  ],
};

const DEVICE_OFFLINE: ChangeSet = {
  source: "laptop", label: "laptop", mode: "git", files: [], error: "laptop is offline. Its changes come back when it reconnects.",
};


const IDLE: TurnLiveness = { kind: "idle" };

const MESSAGES: UIMessage[] = [
  {
    id: "u1", role: "user",
    parts: [{ type: "text", text: "The SAVE20 coupon returns a 500 at checkout. Find out why and fix it." }],
  },
  {
    id: "a1", role: "assistant",
    parts: [
      { type: "text", text: "Found it. Migration 0042 backfilled `kind` for fixed coupons only, so a percentage coupon written before it has no kind, and `applyCoupon` reads `rules[coupon.kind]`." },
      { type: "tool-file", toolCallId: "t1", state: "output-available", input: { action: "edit", path: "packages/checkout/src/apply-coupon.ts" }, output: "ok" },
      { type: "tool-file", toolCallId: "t2", state: "output-available", input: { action: "edit", path: "packages/checkout/src/rules.ts" }, output: "ok" },
      { type: "tool-file", toolCallId: "t3", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "ok" },
      { type: "tool-file", toolCallId: "t4", state: "output-available", input: { action: "write", path: "packages/checkout/tests/coupon-kind.test.ts" }, output: "ok" },
      { type: "tool-run", toolCallId: "t5", state: "output-available", input: { runtime: "sandbox", command: "bun test packages/checkout" }, output: "18 pass\n0 fail" },
    ],
  },
  {
    id: "a2", role: "assistant",
    parts: [{
      type: "text",
      text: "Fixed. `applyCoupon` now reads a missing kind from the value column, a percentage is clamped at its rule's ceiling, and migration 0042 backfills percentage coupons too. I removed the unused legacy discount path and added four tests; all 18 checkout tests pass.",
    }],
  },
];

const APPLY = "packages/checkout/src/apply-coupon.ts";

const CLAMP = "Math.min(coupon.value, rule.maxPercent)";

const CLAMP_AT = (APPLY_AFTER.split("\n")[26] ?? "").indexOf(CLAMP);

const BASELINE = "snapshot 4f1c9a";

const CLAMP_ANCHOR: DiffAnchor = {
  scope: "text", path: APPLY, side: "new", lineStart: 27, lineEnd: 27, charStart: CLAMP_AT, charEnd: CLAMP_AT + CLAMP.length, baseline: BASELINE,
};

const NOTES: readonly ReviewAnnotation[] = [
  noteOf({
    id: "clamp", type: AnnotationType.COMMENT, createdA: NOW - 9 * 60e3, anchor: CLAMP_ANCHOR, quote: CLAMP,
    text: "Clamp it, but log it too: a 90% coupon is a data error someone should hear about.",
  }),
  noteOf({
    id: "label-test", type: AnnotationType.DELETION, createdA: NOW - 7 * 60e3,
    anchor: { scope: "lines", path: "packages/checkout/tests/coupon-kind.test.ts", side: "new", lineStart: 27, lineEnd: 29, baseline: BASELINE },
    quote: (TEST_AFTER.split("\n").slice(26, 29)).join("\n"),
  }),
  noteOf({
    id: "legacy", type: AnnotationType.COMMENT, createdA: NOW - 5 * 60e3,
    anchor: { scope: "file", path: "packages/checkout/src/legacy-discount.ts", baseline: BASELINE },
    quote: "packages/checkout/src/legacy-discount.ts",
    text: "Keep this until the old carts are migrated; they still price through it.",
  }),
];

const SENT: readonly ReviewAnnotation[] = [
  ...NOTES,
  noteOf({
    id: "all", type: AnnotationType.GLOBAL_COMMENT, createdA: NOW - 3 * 60e3, quote: "",
    text: "Good fix. After these, run the checkout tests again and tell me what changed.",
  }),
];

function cardOf(notes: readonly ReviewAnnotation[]): ChangeNotesCard {
  return {
    source: "workspace", label: "Workspace",
    notes: inNoteOrder(notes).map((note) => ({
      id: note.id, type: note.type, ...(note.text !== undefined && { text: note.text }), ...(note.anchor !== undefined && { anchor: note.anchor }),
    })),
  };
}

const WRITING: OpenDraft = {
  anchor: CLAMP_ANCHOR, quote: CLAMP,
  initialText: "Clamp it, but log it too: a 90% coupon is a data error someone should hear about.",
};

const REPLY: UIMessage = {
  id: "a3", role: "assistant",
  parts: [{ type: "text", text: "On it. I'll log a clamped percentage, drop the label test, and keep `legacy-discount.ts` until the old carts are migrated. Then I'll rerun the checkout tests." }],
};

function ChatColumn({ wide, sent, onOpenNote }: { wide: boolean; sent: readonly ReviewAnnotation[] | null; onOpenNote: (anchor: DiffAnchor | undefined) => void }) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<ChatMode>("build");
  const [model, setModel] = useState("anthropic/claude-opus-4");

  return (
    <div className={`flex h-full min-w-0 flex-1 flex-col ${wide ? "border-r p-border" : ""}`}>
      {wide && (
        <SubordinateTabs workspace={WORKSPACE} subordinates={[]} activeName={undefined} onCreate={async () => {}} creating={false}
          onDismiss={async () => {}} onRename={async (_name, displayName) => displayName} />
      )}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-6 lg:px-8 [&>*]:mx-auto [&>*]:max-w-[780px]">
        {MESSAGES.map((message) => <div key={message.id}><MessageView message={message} /></div>)}
        {sent !== null && <FeedbackCard card={cardOf(sent)} sentAt={NOW - 60e3} now={NOW} onOpen={onOpenNote} />}
        {sent !== null && <div><MessageView message={REPLY} /></div>}
      </div>
      <div className="border-t p-border p-sidebar">
        <Composer value={value} onValueChange={setValue} onSend={() => setValue("")} onStop={() => {}} placeholder="Send a message..."
          disabled={false} liveness={IDLE} mode={{ value: mode, onChange: setMode, locked: false }}
          attachments={{ parts: [], onAdd: () => {}, onRemove: () => {} }}
          modelPicker={<ModelPicker models={[{ spec: "anthropic/claude-opus-4", label: "Claude Opus 4", provider: "Anthropic" }]} value={model} onChange={setModel} size="xs" />}
          notices={[]} />
      </div>
    </div>
  );
}

function TabStrip({ label, count }: { label: string; count: number | null }) {
  return (
    <div className={`flex shrink-0 items-stretch border-b p-border ${tabStripH}`}>
      <div className={`p-tabstrip [--scroll-ground:var(--c-sidebar)] -mb-px flex min-w-0 flex-1 items-center gap-0.5 px-3 ${tabStripH}`}>
        {["Work", label, "Files", "Agent", "Environment"].map((tab) => (
          <button key={tab} type="button" aria-current={tab === label ? "true" : undefined} className={`${tabCls} ${tab === label ? "p-tab-active p-accent" : ""}`}>
            <span>{tab}</span>
            {tab === label && count !== null && <span className="p-t-status p-text-3">{count}</span>}
          </button>
        ))}
      </div>
      <div className={`flex shrink-0 items-center border-b p-border ${tabStripH}`}>
        <button type="button" aria-label="Activity" className={`${tabCls} mr-2 px-2.5`}><GaugeIcon size={14} /></button>
      </div>
    </div>
  );
}

function useWide(): boolean {
  const query = "(min-width: 768px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = (): void => setWide(media.matches);

    media.addEventListener("change", sync);

    return () => media.removeEventListener("change", sync);
  }, []);

  return wide;
}

function clampRow(): HTMLElement | null {
  const card = document.querySelector(`[data-file-card="${APPLY}"]`);

  if (card?.querySelector('[data-diff-tinted="pending"]') !== null) return null;

  return card.querySelector<HTMLElement>('[data-note-row][data-side="new"][data-new="27"]');
}

function textRange(code: HTMLElement, start: number, end: number): Range {
  const range = document.createRange();
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let at = 0;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;

    if (start >= at && start <= at + length) range.setStart(node, start - at);

    if (end >= at && end <= at + length) {
      range.setEnd(node, end - at);
      break;
    }

    at += length;
  }

  return range;
}

function useDesignSelection(kind: string | null): void {
  useEffect(() => {
    if (kind === null) return;

    const timer = setInterval(() => {
      const row = clampRow();
      const code = row?.querySelector<HTMLElement>("[data-code]");

      if (row === null || code === null || code === undefined) return;
      clearInterval(timer);

      if (kind === "lines") {
        const gutter = (line: number): Element | null => row.parentElement?.querySelector(`[data-note-row][data-side="new"][data-new="${String(line)}"] > span`) ?? null;

        gutter(25)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        gutter(27)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true }));

        return;
      }

      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(textRange(code, CLAMP_AT, CLAMP_AT + CLAMP.length));
      code.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, 60);

    return () => clearInterval(timer);
  }, [kind]);
}

function DesignSelection({ kind }: { kind: string | null }) {
  useDesignSelection(kind);

  return null;
}

function Workspace({ wide, chatPane, inspector, chat, panel }: { wide: boolean; chatPane: boolean; inspector: number; chat: ReactNode; panel: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <WorkspaceBar title="Checkout coupon bug" onRename={async (name) => name} connectionStatus="connected" working={false} altitude="run" onAltitude={() => {}} />
      <div className="flex shrink-0 items-center gap-1 border-b p-border p-sidebar px-3 py-2 md:hidden">
        <button type="button" aria-pressed={chatPane} className={`rounded-full px-3 py-1.5 text-xs ${chatPane ? "p-accent-subtle p-accent" : "p-text-3"}`}>Chat</button>
        <button type="button" aria-pressed={!chatPane} className={`rounded-full px-3 py-1.5 text-xs ${chatPane ? "p-text-3" : "p-accent-subtle p-accent"}`}>Workspace</button>
      </div>
      <div className="flex min-h-0 flex-1">
        {(wide || chatPane) && chat}
        {(wide || !chatPane) && <div className="flex w-full shrink-0 flex-col p-sidebar" style={wide ? { width: inspector } : undefined}>{panel}</div>}
      </div>
    </div>
  );
}

function setsFor(params: URLSearchParams): readonly ChangeSet[] {
  const laptop = params.get("offline") === "1" ? DEVICE_OFFLINE : DEVICE_CHANGES;

  if (params.get("set") === "edge") return [EDGE_CHANGES];

  return params.has("source") || params.has("menu") ? [COUPON_CHANGES, laptop] : [COUPON_CHANGES];
}

function Scene({ params }: { params: URLSearchParams }) {
  const wide = useWide();
  const sets = setsFor(params);
  const [source, setSource] = useState(params.get("source") ?? sets[0]?.source ?? "workspace");
  const [opened, setOpened] = useState<{ readonly file: string | null; readonly n: number }>({ file: params.get("file"), n: 0 });

  const [reviewedAt, setReviewedAt] = useState<number | null>(params.get("reviewed") === "1" ? NOW - 60e3 : null);
  const [sent, setSent] = useState<readonly ReviewAnnotation[] | null>(params.get("sent") === "1" ? SENT : null);
  const [chatPane, setChatPane] = useState(params.get("pane") === "chat");
  const shown = sets.find((set) => set.source === source) ?? sets[0];

  const initial = params.get("notes") === "1" && sent === null ? NOTES : [];
  const latest = useRef<readonly ReviewAnnotation[]>(initial);

  const store = useMemo<NotesStore>(() => ({
    load: () => Promise.resolve({ ok: true, notes: [...latest.current] }),
    save: (notes) => {
      latest.current = notes;

      return Promise.resolve({ ok: true, notes: [...notes] });
    },
    send: () => {
      setSent(latest.current);
      setChatPane(true);

      return Promise.resolve({ ok: true, notes: [] });
    },
  }), []);

  const openNote = (anchor: DiffAnchor | undefined): void => {
    setSource("workspace");
    setChatPane(false);
    setOpened((prior) => ({ file: anchor?.path ?? null, n: prior.n + 1 }));
  };

  const panel = (
    <>
      <TabStrip label="Changes" count={reviewedAt !== null || shown?.error !== undefined ? null : shown?.files.length ?? null} />
      <div className="min-h-0 flex-1">
        <ChangesPanel key={opened.n} sets={sets} source={source} onSource={setSource} now={NOW} file={opened.file}
          menuOpen={params.get("menu") === "source"} notesOpen={params.get("annotations") === "1"}
          reviewedAt={reviewedAt} onReviewed={() => setReviewedAt(NOW)} onUndo={() => setReviewedAt(null)}
          onOpenInFiles={shown?.mode === "vfs-baseline" ? () => {} : null} />
      </div>
    </>
  );

  return (
    <NotesProvider key={sent === null ? "open" : "sent"} baseline={shown?.baseline ?? BASELINE} files={shown?.files ?? []} now={() => NOW} store={store}
      initial={initial} writing={params.get("comment") === "1" ? WRITING : undefined}>
      <Workspace wide={wide} chatPane={chatPane} inspector={Number(params.get("inspector") ?? 340)} panel={panel}
        chat={<ChatColumn wide={wide} sent={sent} onOpenNote={openNote} />} />
      <DesignSelection kind={params.get("select")} />
    </NotesProvider>
  );
}

export default function diffDesignFrame() {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");

  if (theme === "dark" || theme === "light") {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-mode", theme);
    document.documentElement.style.colorScheme = theme;
  }

  localStorage.setItem(LAYOUT_KEY, params.get("layout") === "unified" ? "unified" : "split");

  return {
    entries: [`/workspace/${WORKSPACE}`],
    node: (
      <>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/workspace/:agentId" element={<Scene params={params} />} />
            <Route path="*" element={<Navigate to={`/workspace/${WORKSPACE}`} replace />} />
          </Route>
        </Routes>
        {params.get("review") !== "0" && <ReviewBar />}
      </>
    ),
  };
}
