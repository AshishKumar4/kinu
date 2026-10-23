import { RuleTester } from "oxlint/plugins-dev";

import { noStorageRestoreOutsideOpsRule } from "./no-storage-restore-outside-ops.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const product = "/repo/packages/cf-backend/src/agent-facet/agent-facet.ts";
const restore = "/repo/packages/core/src/state/ops-restore.ts";

const restoreError = (call: string) => ({ messageId: "restore", data: { call } });

tester.run("anti-slop/no-storage-restore-outside-ops", noStorageRestoreOutsideOpsRule, {
  valid: [
    { filename: restore, code: "const bookmark = await storage.getBookmarkForTime(at); await storage.onNextSessionRestoreBookmark(bookmark);" },
    { filename: product, code: "const now = await this.ctx.storage.getCurrentBookmark();" },
    { filename: product, code: "const name = 'getBookmarkForTime';" },
    { filename: product, code: "await stub.opsRestore(caller, { at });" },
  ],
  invalid: [
    { filename: product, code: "await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);", errors: [restoreError("onNextSessionRestoreBookmark")] },
    { filename: product, code: "const bookmark = await this.ctx.storage.getBookmarkForTime(Date.now() - 60_000);", errors: [restoreError("getBookmarkForTime")] },
    { filename: product, code: "await this.ctx.storage['onNextSessionRestoreBookmark'](bookmark);", errors: [restoreError("onNextSessionRestoreBookmark")] },
    { filename: product, code: "const { onNextSessionRestoreBookmark: arm } = this.ctx.storage; await arm(bookmark);", errors: [restoreError("onNextSessionRestoreBookmark")] },
    { filename: "/repo/packages/core/src/state/ops-restore.test-helper.ts", code: "storage.getBookmarkForTime(at);", errors: [restoreError("getBookmarkForTime")] },
  ],
});
