import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAmbientGitInTestsRule } from "./rules/no-ambient-git-in-tests.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noElapsedWorkDeadlineRule } from "./rules/no-elapsed-work-deadline.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noCopyRpcStubRule } from "./rules/no-copy-rpc-stub.ts";
import { noDdlInCatchRule } from "./rules/no-ddl-in-catch.ts";
import { noEmptyCatchRule } from "./rules/no-empty-catch.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noManufacturedSqlColumnRule } from "./rules/no-manufactured-sql-column.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noNearDuplicateFunctionsRule } from "./rules/no-near-duplicate-functions.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noOutputTokenCapRule } from "./rules/no-output-token-cap.ts";
import { requireRpcSealRule } from "./rules/require-rpc-seal.ts";
import { requireSuperAlarmRule } from "./rules/require-super-alarm.ts";
import { noTuiColourLiteralRule } from "./rules/no-tui-colour-literal.ts";
import { requireVariantUtilityRule } from "./rules/require-variant-utility.ts";
import { noCliCredentialFlagRule } from "./rules/no-cli-credential-flag.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noSentinelCatchRule } from "./rules/no-sentinel-catch.ts";
import { noUnaccountedCatchRule } from "./rules/no-unaccounted-catch.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noSyncSpawnRule } from "./rules/no-sync-spawn.ts";
import { noUntypedConsoleRule } from "./rules/no-untyped-console.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noVacuousTypePredicateRule } from "./rules/no-vacuous-type-predicate.ts";
import { noWaitUntilInDurableObjectRule } from "./rules/no-wait-until-in-durable-object.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireCauseOnRethrowRule } from "./rules/require-cause-on-rethrow.ts";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.ts";
import { requireRuntimeImportExtensionRule } from "./rules/require-runtime-import-extension.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

/**
 * Generic Oxlint rules that reject low-evidence and low-signal implementation patterns, plus the
 * Kinu-local rules (see upstream.json's `kinuRules`): the no-swallow family,
 * no-wait-until-in-durable-object, no-copy-rpc-stub, no-untyped-console,
 * require-runtime-import-extension, and the two design-smell rules
 * no-near-duplicate-functions and no-manufactured-sql-column.
 */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-ambient-git-in-tests": noAmbientGitInTestsRule,
		"no-elapsed-work-deadline": noElapsedWorkDeadlineRule,
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
		"no-copy-rpc-stub": noCopyRpcStubRule,
		"no-ddl-in-catch": noDdlInCatchRule,
		"no-empty-catch": noEmptyCatchRule,
		"no-known-value-widening": noKnownValueWideningRule,
		"no-module-mocking": noModuleMockingRule,
		"no-object-parameters": noObjectParametersRule,
		"no-output-token-cap": noOutputTokenCapRule,
		"require-rpc-seal": requireRpcSealRule,
		"require-super-alarm": requireSuperAlarmRule,
		"no-tui-colour-literal": noTuiColourLiteralRule,
		"require-variant-utility": requireVariantUtilityRule,
		"no-cli-credential-flag": noCliCredentialFlagRule,
		"no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-runtime-typeof": noRuntimeTypeofRule,
		"no-sentinel-catch": noSentinelCatchRule,
		"no-unaccounted-catch": noUnaccountedCatchRule,
		"no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
		"no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
		"no-manufactured-sql-column": noManufacturedSqlColumnRule,
		"no-near-duplicate-functions": noNearDuplicateFunctionsRule,
		"no-unknown-parameters": noUnknownParametersRule,
		"no-sync-spawn": noSyncSpawnRule,
		"no-untyped-console": noUntypedConsoleRule,
		"no-unknown-returns": noUnknownReturnsRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-vacuous-type-predicate": noVacuousTypePredicateRule,
		"no-wait-until-in-durable-object": noWaitUntilInDurableObjectRule,
		"no-widen-then-assert": noWidenThenAssertRule,
		"require-cause-on-rethrow": requireCauseOnRethrowRule,
		"require-readable-spacing": requireReadableSpacingRule,
		"require-runtime-import-extension": requireRuntimeImportExtensionRule,
		"require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
	},
});

export default antiSlopPlugin;
