/**
 * Renders whose answer to the judge's `DIFFERENT_DESIGNS` is known, for `evals/scripts/calibrate-judge.ts`: the
 * pricing-treatments task's three plans drawn as really different designs, and as one design varied only in colour,
 * font or wording, which must not count as different.
 */

const PLANS = [
  { plan: 'Starter', monthly: '$19', yearly: '$205.20', seats: '3 seats', storage: '50 GB', support: 'Email' },
  { plan: 'Team', monthly: '$49', yearly: '$499.80', seats: '10 seats', storage: '250 GB', support: 'Chat' },
  { plan: 'Business', monthly: '$129', yearly: '$1,238.40', seats: '50 seats', storage: '2,000 GB', support: 'Phone and chat' },
];

function page(style: string, body: string): string {
  return `<!doctype html><html><head><style>body{margin:16px;font:14px system-ui,sans-serif}${style}</style></head><body>${body}</body></html>`;
}

/** Three cards side by side, the middle one raised; `accent` and `font` vary it without changing the design. */
function cards(accent: string, font = 'system-ui,sans-serif', yearlyLabel = 'billed yearly'): string {
  return page(`body{font-family:${font}}.row{display:flex;gap:12px}.card{flex:1;border:1px solid #ddd;border-radius:10px;padding:14px}
    .card.pop{border:2px solid ${accent};transform:translateY(-6px)}.price{font-size:28px;font-weight:700;color:${accent}}
    li{margin:4px 0}button{background:${accent};color:#fff;border:0;border-radius:6px;padding:8px 12px;width:100%}`,
  `<div class="row">${PLANS.map((plan, index) => `<div class="card${index === 1 ? ' pop' : ''}"><h3>${plan.plan}</h3>
    <div class="price">${plan.monthly}<small>/mo</small></div><div>${plan.yearly} ${yearlyLabel}</div>
    <ul><li>${plan.seats}</li><li>${plan.storage}</li><li>${plan.support} support</li></ul><button>Choose ${plan.plan}</button></div>`).join('')}</div>`);
}

/** A comparison grid: features down the side, plans across the top. */
function grid(): string {
  return page('table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e5e5;padding:8px;text-align:center}td:first-child{text-align:left;color:#666}',
    `<table><tr><th></th>${PLANS.map((plan) => `<th>${plan.plan}</th>`).join('')}</tr>
    <tr><td>Monthly</td>${PLANS.map((plan) => `<td>${plan.monthly}</td>`).join('')}</tr>
    <tr><td>Yearly</td>${PLANS.map((plan) => `<td>${plan.yearly}</td>`).join('')}</tr>
    <tr><td>Seats</td>${PLANS.map((plan) => `<td>${plan.seats}</td>`).join('')}</tr>
    <tr><td>Storage</td>${PLANS.map((plan) => `<td>${plan.storage}</td>`).join('')}</tr>
    <tr><td>Support</td>${PLANS.map((plan) => `<td>${plan.support}</td>`).join('')}</tr></table>`);
}

/** A stacked list: one wide row per plan, the price at the right. */
function rows(): string {
  return page('.plan{display:flex;align-items:center;justify-content:space-between;background:#f6f6f8;border-radius:8px;padding:12px 16px;margin:8px 0}.plan b{font-size:18px}',
    PLANS.map((plan) => `<div class="plan"><div><b>${plan.plan}</b><div>${plan.seats} · ${plan.storage} · ${plan.support}</div></div>
      <div style="text-align:right"><b>${plan.monthly} a month</b><div>or ${plan.yearly} a year</div></div></div>`).join(''));
}

/** Each set of renders, and whether the judge should call them different designs. */
export const DESIGN_SETS: readonly { readonly id: string; readonly different: boolean; readonly pages: readonly string[] }[] = [
  { id: 'cards-grid-rows', different: true, pages: [cards('#4f46e5'), grid(), rows()] },
  { id: 'rows-cards-grid', different: true, pages: [rows(), cards('#0f766e'), grid()] },
  { id: 'cards-recoloured', different: false, pages: [cards('#4f46e5'), cards('#dc2626'), cards('#059669')] },
  { id: 'cards-refonted-and-reworded', different: false, pages: [cards('#4f46e5'), cards('#4f46e5', 'Georgia,serif'), cards('#4f46e5', 'system-ui,sans-serif', 'when paid annually')] },
  { id: 'two-alike', different: false, pages: [cards('#4f46e5'), grid(), cards('#ea580c')] },
];
