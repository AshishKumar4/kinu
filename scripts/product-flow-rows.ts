/** Each deployed product flow is one independently graded Armada task. */
import * as v from 'valibot';

const ProductFlowRow = v.picklist([
  'welcome', 'first-answer', 'agent-return', 'agent-plan', 'workspace-proposal', 'account-memory', 'stack-memory',
  'splice', 'approval-stack', 'hire-approval', 'panel', 'stamped', 'written-file', 'changes-storm', 'live-memory',
  'slate-preview', 'drive', 'drive-opens', 'slate-opens', 'slate-share', 'pin', 'titled-chat', 'hire-home',
  'slate-reach', 'plan-comment',
]);

export const PRODUCT_FLOW_ROWS = ProductFlowRow.options;

export type ProductFlowRow = v.InferOutput<typeof ProductFlowRow>;

/** The runner selects a stable row id, not incidental assertion prose. */
export function productFlowTestName(row: ProductFlowRow, title: string): string {
  return `product-flow:${row} ${title}`;
}

if (import.meta.main) {
  const row = PRODUCT_FLOW_ROWS.find((id) => process.argv[2] === `--flow=${id}`);

  if (row === undefined) throw new Error(`Expected --flow=<${PRODUCT_FLOW_ROWS.join('|')}>`);
  console.log(`^${productFlowTestName(row, '')}`);
}
