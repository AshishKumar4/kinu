import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** The calls that arm a restore of an object's storage, or find the moment one goes back to. */
const RESTORE_CALLS: Readonly<Record<string, true>> = { getBookmarkForTime: true, onNextSessionRestoreBookmark: true };

/** The one module that may make them: the operator's restore (ARCHITECTURE-DECISIONS W7). */
const OPS_RESTORE = "/packages/core/src/state/ops-restore.ts";

function nameOf(node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;

  return null;
}

/**
 * Only `packages/core/src/state/ops-restore.ts` reaches a Durable Object's point-in-time restore. A facet's storage has the calls, shares its
 * object's history, and its `onNextSessionRestoreBookmark` reverted the whole object, parent and every facet, at the
 * parent's next start (kinu-probe-pitr, staging 2026-10-23): one stray call is a workspace silently rewound later.
 */
export const noStorageRestoreOutsideOpsRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Allow a Durable Object's point-in-time restore calls only in packages/core/src/state/ops-restore.ts." },
    messages: {
      restore:
        "`{{call}}` arms or aims a restore of the object's whole storage, every facet with it, at its next start. Restore only through packages/core/src/state/ops-restore.ts (scripts/restore.ts, ARCHITECTURE-DECISIONS W7).",
    },
  },
  createOnce(context) {
    let exempt = false;

    return {
      Program() {
        exempt = context.filename.replaceAll("\\", "/").endsWith(OPS_RESTORE);
      },
      MemberExpression(node) {
        const call = nameOf(node.property);

        if (exempt || call === null || RESTORE_CALLS[call] !== true) return;
        context.report({ node, messageId: "restore", data: { call } });
      },
      Property(node) {
        const call = nameOf(node.key);

        if (exempt || call === null || RESTORE_CALLS[call] !== true || node.parent?.type !== "ObjectPattern") return;
        context.report({ node, messageId: "restore", data: { call } });
      },
    };
  },
});
