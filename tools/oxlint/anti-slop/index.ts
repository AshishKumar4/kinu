import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAmbientGitInTestsRule } from "./rules/no-ambient-git-in-tests.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noCopyRpcStubRule } from "./rules/no-copy-rpc-stub.ts";
import { noDdlInCatchRule } from "./rules/no-ddl-in-catch.ts";
import { noEmptyCatchRule } from "./rules/no-empty-catch.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noSentinelCatchRule } from "./rules/no-sentinel-catch.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUntypedConsoleRule } from "./rules/no-untyped-console.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWaitUntilInDurableObjectRule } from "./rules/no-wait-until-in-durable-object.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireCauseOnRethrowRule } from "./rules/require-cause-on-rethrow.ts";
import { requireRuntimeImportExtensionRule } from "./rules/require-runtime-import-extension.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

/**
 * Generic Oxlint rules that reject low-evidence and low-signal implementation patterns, plus the
 * Proteus-local rules (see upstream.json's `proteusRules`): the no-swallow family,
 * no-wait-until-in-durable-object, no-copy-rpc-stub, no-untyped-console, and
 * require-runtime-import-extension.
 */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-ambient-git-in-tests": noAmbientGitInTestsRule,
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
		"no-copy-rpc-stub": noCopyRpcStubRule,
		"no-ddl-in-catch": noDdlInCatchRule,
		"no-empty-catch": noEmptyCatchRule,
		"no-known-value-widening": noKnownValueWideningRule,
		"no-module-mocking": noModuleMockingRule,
		"no-object-parameters": noObjectParametersRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-runtime-typeof": noRuntimeTypeofRule,
		"no-sentinel-catch": noSentinelCatchRule,
		"no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
		"no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
		"no-unknown-parameters": noUnknownParametersRule,
		"no-untyped-console": noUntypedConsoleRule,
		"no-unknown-returns": noUnknownReturnsRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-wait-until-in-durable-object": noWaitUntilInDurableObjectRule,
		"no-widen-then-assert": noWidenThenAssertRule,
		"require-cause-on-rethrow": requireCauseOnRethrowRule,
		"require-runtime-import-extension": requireRuntimeImportExtensionRule,
		"require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
	},
});

export default antiSlopPlugin;
