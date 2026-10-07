// How often the judge (evals/src/judge.ts) agrees with renders whose answer is known:
//   KINU_EVAL_ORIGIN=<deployment> bun evals/scripts/calibrate-judge.ts [--asks <n>] [--out <dir>]
// Each set of `fixtures/pricing-designs.ts` is drawn in Chrome at chat width and put to the judge `--asks` times
// (default 5), every ask at once, on the deployment as eval-service. Prints each set's verdicts and the agreement over
// all asks; `--out` keeps the pictures and every reply.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withTestChrome } from '../../scripts/test-chrome';
import { DESIGN_SETS } from '../src/fixtures/pricing-designs';
import { DIFFERENT_DESIGNS, judge } from '../src/judge';
import { resolveEvalTarget } from '../src/target';

const { values } = parseArgs({ options: { asks: { type: 'string', default: '5' }, out: { type: 'string' } } });

const asks = Number(values.asks);

if (!Number.isInteger(asks) || asks < 1) throw new Error('Usage: bun evals/scripts/calibrate-judge.ts [--asks <n>] [--out <dir>]');

const target = resolveEvalTarget(process.env);

const drawn = await withTestChrome(async (browser) => Promise.all(DESIGN_SETS.map(async (set) => {
  const pictures = [];

  for (const html of set.pages) {
    const page = await browser.newPage();

    await page.setViewport({ width: 720, height: 420 });
    await page.setContent(html);
    pictures.push(new Uint8Array(await page.screenshot({ type: 'png' })));
    await page.close();
  }

  return { ...set, pictures };
})));

const judged = await Promise.all(drawn.flatMap((set) => Array.from({ length: asks }, async (_, ask) => ({
  set: set.id, ask, expected: set.different, ...await judge(target, DIFFERENT_DESIGNS, set.pictures),
}))));

const agreed = judged.filter((judgement) => judgement.verdict === judgement.expected).length;

for (const set of drawn) {
  const verdicts = judged.filter((judgement) => judgement.set === set.id).map((judgement) => String(judgement.verdict));

  process.stdout.write(`${set.id} (different: ${String(set.different)}): ${verdicts.join(' ')}\n`);
}

process.stdout.write(`agreement: ${String(agreed)} of ${String(judged.length)} (${(100 * agreed / judged.length).toFixed(0)}%)\n`);

if (values.out !== undefined) {
  for (const set of drawn) {
    mkdirSync(join(values.out, set.id), { recursive: true });

    for (const [index, picture] of set.pictures.entries()) writeFileSync(join(values.out, set.id, `${String(index + 1)}.png`), picture);
  }

  writeFileSync(join(values.out, 'judged.json'), `${JSON.stringify(judged, null, 2)}\n`);
}
