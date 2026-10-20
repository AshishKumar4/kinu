/**
 * The hand-labelling page, served on this machine only:
 *
 *   bun evals/omp/label.ts --data /mnt/local/kinu/datasets/omp/proteus
 *
 * Draws `label-items.json` from `train.jsonl` once (150 messages, 60 answers, seed 1) and keeps it; each answer is
 * appended to `labels.jsonl` as it is given, so closing the page loses nothing and reopening resumes.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { AGAIN_LABELS, LabelItemSchema, labelSample, MESSAGE_LABELS, type LabelItem } from '../src/omp-labels';
import { ownerTurnsFrom } from '../src/omp';

const LabelText = v.pipe(v.string(), v.parseJson(), v.object({ id: v.string(), key: v.picklist([1, 2, 3, 4]) }));

const PORT = 7788;

function page(items: readonly LabelItem[], done: ReadonlyMap<string, number>): string {
  const data = JSON.stringify({ items, done: Object.fromEntries(done), labels: { message: MESSAGE_LABELS, again: AGAIN_LABELS } }).replaceAll('<', '\\u003c');

  return `<!doctype html><meta charset="utf-8"><title>Labels</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1d1d1f}
.k{font-size:12px;color:#6e6e73;text-transform:uppercase;letter-spacing:.04em;margin-top:14px}
pre{white-space:pre-wrap;margin:4px 0;font:inherit}
.said{background:#f5f5f7;border-radius:8px;padding:8px 10px}
.keys{display:flex;gap:8px;margin-top:18px}.keys span{border:1px solid #d2d2d7;border-radius:8px;padding:6px 10px}
.q{font-weight:600;margin-top:16px}#n{color:#6e6e73;font-size:13px}
</style>
<div id="n"></div><div id="item"></div>
<script>
const {items, done, labels} = ${data};
let at = items.findIndex((item) => !(item.id in done)); if (at < 0) at = items.length;
const show = () => {
  const item = items[at], box = document.getElementById('item');
  document.getElementById('n').textContent = Math.min(at + 1, items.length) + ' / ' + items.length + '   ←  back';
  if (!item) { box.innerHTML = '<p class="q">Done.</p>'; return; }
  const text = (k, t, cls) => '<div class="k">' + k + '</div><pre' + (cls ? ' class="' + cls + '"' : '') + '></pre>';
  box.innerHTML = text('Asked') + text('Answer') + text(item.kind === 'message' ? 'Then you said' : 'You later said', '', 'said')
    + (item.kind === 'again' ? '<div class="q">Would you have to say this again?</div>' : '')
    + '<div class="keys">' + labels[item.kind].map((l, i) => '<span>' + (i + 1) + ' ' + l + (done[item.id] === i + 1 ? ' ✓' : '') + '</span>').join('') + '</div>';
  const pres = box.querySelectorAll('pre'); pres[0].textContent = item.asked; pres[1].textContent = item.answer; pres[2].textContent = item.said;
};
addEventListener('keydown', async (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'Backspace') { at = Math.max(0, at - 1); show(); return; }
  const key = Number(e.key), item = items[at];
  if (!item || !(key >= 1 && key <= 4)) return;
  const sent = await fetch('/label', { method: 'POST', body: JSON.stringify({ id: item.id, key }) });
  if (!sent.ok) { document.getElementById('n').textContent = 'Not saved: ' + sent.status; return; }
  done[item.id] = key; at += 1; show();
});
show();
</script>`;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { data: { type: 'string' } } });

  if (values.data === undefined) throw new Error('--data is required');
  const itemsPath = join(values.data, 'label-items.json');
  const labelsPath = join(values.data, 'labels.jsonl');

  if (!existsSync(itemsPath)) {
    const train = ownerTurnsFrom(readFileSync(join(values.data, 'train.jsonl'), 'utf8'));
    writeFileSync(itemsPath, JSON.stringify(labelSample(train, { messages: 150, again: 60, seed: 1 })));
  }

  const items = v.parse(v.pipe(v.string(), v.parseJson(), v.array(LabelItemSchema)), readFileSync(itemsPath, 'utf8'));
  const known = new Set(items.map((item) => item.id));

  const done = (): Map<string, number> => new Map((existsSync(labelsPath) ? readFileSync(labelsPath, 'utf8').split('\n').filter(Boolean) : [])
    .map((line) => v.parse(LabelText, line)).map((label) => [label.id, label.key] as const));

  Bun.serve({
    hostname: '127.0.0.1', port: PORT,
    fetch: async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/label') {
        const label = v.safeParse(LabelText, await request.text());

        if (!label.success || !known.has(label.output.id)) return new Response('bad label', { status: 400 });
        appendFileSync(labelsPath, `${JSON.stringify({ ...label.output, at: new Date().toISOString() })}\n`);

        return new Response('ok');
      }

      return new Response(page(items, done()), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  process.stdout.write(`http://127.0.0.1:${String(PORT)}  ${String(items.length)} items, ${String(done().size)} labelled\n`);
}
