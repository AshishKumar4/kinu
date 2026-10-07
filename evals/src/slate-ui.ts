/**
 * An answer's ephemeral slates: `<slate-ui name="…">…HTML…</slate-ui>` blocks in what the agent said, each drawn in
 * the chat as a frame of its own, its source the stored message and never a file. The chat card's attribute is the
 * settled design's until core exports the feature's own `SLATE_UI_ATTRIBUTE`; then this module goes.
 */
export const SLATE_UI_ATTRIBUTE = 'data-slate-ui';
