/**
 * A turn's runs of tool calls in the real chat (`frame=workspacepage&transcript=toolruns`): an answer that searched and
 * read its way to the cause, a long fix with a failed test mid-run, and a run split by a preview it started and by a
 * question for the owner. `gallery:tool-run` with `{ calls, failAt?, answer?, agent? }` shows `agent`'s chat (the
 * workspace's by default) with a newest turn of that many calls, the newest running unless the answer has started; a
 * test drives the run through its states with it, against the claim it pushes.
 */
import type { UIMessage } from "ai";
import * as v from "valibot";
import { hostedActorSocketPath } from "@kinu.run/core";
import { galleryChatWindow, seedGalleryChat } from "@/gallery-agent-stub";
import { SLATE_GALLERY_URL } from "@/gallery-slate-fallback";

type Part = UIMessage["parts"][number];

const NOW = Date.now();

const at = (minutesAgo: number) => NOW - minutesAgo * 60e3;

/** A message as the transport stamps it. */
const row = (message: UIMessage & { createdAt: number }) => message;

const said = (text: string): Part => ({ type: "text", state: "done", text });

const thought = (text: string): Part => ({ type: "reasoning", state: "done", text });

const read = (id: string, path: string): Part => ({ type: "tool-file", toolCallId: id, state: "output-available", input: { op: "read", path }, output: "…" });

const edit = (id: string, path: string): Part => ({ type: "tool-file", toolCallId: id, state: "output-available", input: { op: "edit", path, edits: [{}] }, output: "ok" });

const command = (id: string, line: string, output = "ok"): Part => ({ type: "tool-shell", toolCallId: id, state: "output-available", input: { runtime: "workspace", command: line }, output });

const failed = (id: string, line: string, error: string): Part => ({ type: "tool-shell", toolCallId: id, state: "output-error", input: { runtime: "workspace", command: line }, errorText: error });

const search = (id: string, query: string): Part => ({ type: "tool-web", toolCallId: id, state: "output-available", input: { op: "search", query }, output: "…" });

const page = (id: string, url: string): Part => ({ type: "tool-web", toolCallId: id, state: "output-available", input: { op: "fetch", url }, output: "…" });

const STEP: Part = { type: "step-start" };

/** The ask a run stops at, as `ask_owner` puts it. */
const DEPLOY_ASK = {
  questions: [{
    id: "deploy", header: "Deploy", question: "The preview is up. Deploy the fix to staging now?", recommended: 0,
    options: [{ label: "Deploy now", description: "Staging gets the fix in about two minutes." }, { label: "Wait", description: "Keep the preview; deploy later." }],
  }],
};

/** Twenty-two calls fixing the bug, a test run failing in the middle. */
const FIX_RUN: Part[] = [
  thought("**Fixing the guard**\n\nThe lookup needs a fallback for coupons the migration left without a kind."),
  ...["apply-coupon.ts", "rules.ts", "coupon.ts", "infer-kind.ts"].map((file, index) => read(`fix-read-${String(index)}`, `packages/checkout/src/${file}`)),
  edit("fix-edit-1", "packages/checkout/src/apply-coupon.ts"),
  STEP,
  failed("fix-test-1", "bun test packages/checkout", "2 failed: percentage coupon without kind › applies 20%; fixed coupon › keeps its amount"),
  thought("The fallback inferred a fixed kind for percentages. `inferKind` reads the amount's unit, not its sign."),
  read("fix-read-4", "packages/checkout/src/infer-kind.ts"),
  edit("fix-edit-2", "packages/checkout/src/infer-kind.ts"),
  command("fix-test-2", "bun test packages/checkout", "48 pass, 0 fail"),
  STEP,
  ...["cart.ts", "totals.ts", "receipt.ts", "admin/coupons.ts", "api/apply.ts", "api/preview.ts"].map((file, index) => read(`fix-site-${String(index)}`, `packages/checkout/src/${file}`)),
  edit("fix-edit-3", "packages/checkout/src/api/preview.ts"),
  command("fix-test-3", "bun test packages/checkout packages/admin", "131 pass, 0 fail"),
  command("fix-lint", "bun run lint", "clean"),
  edit("fix-notes", "CHANGELOG.md"),
  command("fix-git", "git commit -am 'fix(checkout): coupons without a kind infer it'", "[fix/coupon-kind 3f2a91c]"),
];

const THREAD: UIMessage[] = [
  row({ id: "tr-u1", role: "user", createdAt: at(30), parts: [said("SAVE20 fails at checkout with a 500. Find out why.")] }),
  row({
    id: "tr-a1", role: "assistant", createdAt: at(29),
    parts: [
      thought("**Reproducing the failure**\n\nFirst the handler, then the migration that landed Tuesday."),
      STEP,
      read("why-read-1", "packages/checkout/src/apply-coupon.ts"),
      read("why-read-2", "packages/checkout/migrations/0042_coupon_kind.sql"),
      thought("The migration nulls `kind` on percentage coupons. Is that a known pattern for this ORM's backfills?"),
      search("why-search", "coupon kind null after migration backfill"),
      page("why-page-1", "https://orm.example.dev/docs/migrations/backfill"),
      page("why-page-2", "https://github.com/example/orm/issues/1182"),
      page("why-page-3", "https://orm.example.dev/docs/nullable-enums"),
      STEP,
      said("The 500 is a dereference of `rules[kind]`: Tuesday's migration left every percentage coupon with `kind: null`, and SAVE20 is the only live one. SAVE10 is a fixed coupon, so it never reaches that branch."),
    ],
  }),
  row({ id: "tr-u2", role: "user", createdAt: at(20), parts: [said("Fix it, and run the whole suite.")] }),
  row({
    id: "tr-a2", role: "assistant", createdAt: at(19),
    parts: [...FIX_RUN, STEP, said("Fixed. Coupons without a kind now infer it from the amount's unit, and all 131 checkout and admin tests pass. The first attempt read percentages as fixed; the second run caught it.")],
  }),
  row({ id: "tr-u3", role: "user", createdAt: at(10), parts: [said("Put up a preview, and ask me before you deploy.")] }),
  row({
    id: "tr-a3", role: "assistant", createdAt: at(9),
    parts: [
      command("pv-build", "bun run build", "built in 4.1s"),
      command("pv-serve", "bun run preview --port 8789", "listening on 8789"),
      { type: "tool-shell", toolCallId: "pv-expose", state: "output-available", input: { runtime: "workspace", command: "kinu expose 8789" }, output: { url: SLATE_GALLERY_URL, port: 8789 } },
      read("pv-check-1", "packages/checkout/src/api/apply.ts"),
      command("pv-check-2", "curl -s localhost:8789/api/apply?code=SAVE20", "{\"total\":1599}"),
      STEP,
      said("The preview applies SAVE20 correctly: $19.99 comes to $15.99."),
      { type: "tool-ask_owner", toolCallId: "pv-ask", state: "input-available", input: DEPLOY_ASK },
    ],
  }),
];

/** The turn a test drives live, asked after the thread above. */
const TOOL_RUN_TURN = "tr-u4";

const ASKED: UIMessage = row({ id: TOOL_RUN_TURN, role: "user", createdAt: at(1), parts: [said("Check every other call site of applyCoupon.")] });

/** The kinds of call a live run cycles through, so its line has work of several kinds to name. */
const LIVE_CALLS: readonly ((id: string, index: number) => Part)[] = [
  (id, index) => read(id, `packages/checkout/src/call-site-${String(index)}.ts`),
  (id, index) => read(id, `packages/admin/src/coupons-${String(index)}.ts`),
  (id) => search(id, "applyCoupon callers outside checkout"),
  (id, index) => command(id, `rg -n "applyCoupon(" packages/${String(index)}`, "3 matches"),
];

const RunAskedSchema = v.object({ calls: v.number(), failAt: v.optional(v.number()), answer: v.optional(v.boolean()), agent: v.optional(v.string()) });

/** The newest turn with `calls` calls so far, a thought every fifth; the newest runs until the answer starts. */
function liveTurn({ calls, failAt, answer = false }: v.InferOutput<typeof RunAskedSchema>): UIMessage {
  const parts: Part[] = [];

  for (let index = 0; index < calls; index += 1) {
    if (index % 5 === 0) parts.push(STEP, thought(`Call sites ${String(index + 1)} to ${String(index + 5)}: each passes the coupon straight through, or reads its kind first?`));
    const id = `live-${String(index)}`;
    const call = LIVE_CALLS[index % LIVE_CALLS.length]?.(id, index) ?? read(id, "packages/checkout/src/index.ts");

    if (index === failAt) parts.push(failed(id, `rg -n "applyCoupon(" packages/legacy`, "rg: packages/legacy: No such file or directory"));
    else if (index === calls - 1 && !answer && "toolCallId" in call) parts.push({ type: "tool-shell", toolCallId: id, state: "input-available", input: { runtime: "workspace", command: `bun test --filter applyCoupon-${String(index)}` } });
    else parts.push(call);
  }

  if (answer) parts.push(STEP, { type: "text", state: "streaming", text: "Every other call site reads the coupon's kind before it applies it, so" });

  return { id: "tr-a4", role: "assistant", parts };
}

/** The hired agent whose chat holds the thread too. */
const HIRED = "coupon-auditor";

/** `transcript=toolruns`: the thread above, in the workspace's own chat and in a hired agent's. */
export function seedToolRuns(transcript: string | null): void {
  if (transcript !== "toolruns") return;
  seedGalleryChat(THREAD);
  seedGalleryChat(THREAD, hostedActorSocketPath(HIRED));

  window.addEventListener("gallery:tool-run", (event: Event) => {
    const asked = event instanceof CustomEvent ? v.safeParse(RunAskedSchema, event.detail) : null;

    if (asked?.success !== true) return;
    const { agent } = asked.output;

    galleryChatWindow(agent === undefined ? "" : hostedActorSocketPath(agent), [...THREAD, ASKED, liveTurn(asked.output)]);
  });
}
