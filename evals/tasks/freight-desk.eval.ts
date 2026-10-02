
import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import type { EvalVerifier } from '../src/verifier';
import { Seeded } from './seeded';
import { reusedInLaterTurn, ToolTurnUseSchema } from './crafted-reuse';
import { published } from './npm';

// A freight co-op's month at its desk: the agent builds itself a tool for the manifests that come in and uses it; a
// month later the forwarder's manifests arrive as a zip, one of them September's again under an October name, which it
// unpacks without the copy and runs the same tool over; then a question only the live web answers. Graded on what the Tools pane and the Files tab show, and on the answers: the totals
// computed here from the same manifests, the versions asked of the npm registry when the check runs.

const MISSION = "Harbor Freight Co-op's workspace. We check every shipping manifest that comes in, with tools we keep for it.";

const DIR = '/home/user/manifests';

const OCTOBER_DIR = `${DIR}/2027-10`;

const TOOL = 'manifest_totals';

// ── The manifests ────────────────────────────────────────────────────

type Line = { sku: string; qty: number; gramsEach: number };

function manifest(seed: number, lines: number): Line[] {
  const random = new Seeded(seed);

  return Array.from({ length: lines }, (_, index) => ({
    sku: `HF-${String(1000 + index * 7 + random.int(0, 6))}`,
    qty: random.int(1, 240),
    gramsEach: random.int(40, 38_000),
  }));
}

function csv(lines: readonly Line[]): string {
  return `sku,qty,unit_weight_kg\n${lines.map((line) => `${line.sku},${String(line.qty)},${(line.gramsEach / 1000).toFixed(3)}`).join('\n')}\n`;
}

const SEPTEMBER = manifest(0x5e97, 64);

const OCTOBER = [
  { name: '2027-10-04.csv', lines: manifest(0x0c04, 71) },
  { name: '2027-10-18.csv', lines: manifest(0x0c18, 58) },
];

/** September's manifest, byte for byte, as the forwarder re-sent it: only its content says it is a copy. */
const RESENT = { name: '2027-10-11.csv', lines: SEPTEMBER };

/** A zip of `files`, stored rather than deflated: every unzip reads it, and its bytes are fixed by its inputs. */
function zip(files: readonly { name: string; content: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = Bun.hash.crc32(data);
    const local = new DataView(new ArrayBuffer(30));

    // Local file header: version 2.0, no flags, stored, a fixed 2027-01-01 00:00 timestamp.
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, (47 << 9) | (1 << 5) | 1, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));

    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(14, (47 << 9) | (1 << 5) | 1, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));

  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }

  return bytes;
}

// ── The checker's answers ────────────────────────────────────────────

function totals(lines: readonly Line[]) {
  return {
    qty: lines.reduce((sum, line) => sum + line.qty, 0),
    kg: lines.reduce((sum, line) => sum + line.qty * line.gramsEach, 0) / 1000,
  };
}

async function checkTotals(verifier: EvalVerifier, id: string, lines: readonly Line[]): Promise<void> {
  await verifier.check(id, async () => {
    const expected = totals(lines);
    const found = verifier.bareAnswer(/^(\d+\s*[,;]?\s+\d+(?:\.\d+)?)(?:\s*kg)?$/u);
    const [qty, kg] = found === null ? [] : found.split(/[\s,;]+/u).map(Number);

    return {
      pass: qty === expected.qty && kg !== undefined && Math.abs(kg - expected.kg) <= 0.0051,
      evidence: { answer: found, expected: `${String(expected.qty)} ${expected.kg.toFixed(2)}`, replies: verifier.recentReplies() },
    };
  });
}

const PACKAGES = ['valibot', 'hono', 'zod'] as const;

/** The version a reply gives for `name`: the last line naming the package, then a version. */
function answered(replies: readonly string[], name: string): string | null {
  const line = new RegExp(`(?:^|[\\s*\`'"(])${name}[\\s*\`'":@=-]+v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)`, 'u');

  for (const reply of [...replies].reverse()) {
    for (const text of reply.split(/\r?\n/u).reverse()) {
      const found = line.exec(text);

      if (found?.[1] !== undefined) return found[1];
    }
  }

  return null;
}

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'freight-desk',
  mission: MISSION,
  turns: [{
    seed: [{ path: `${DIR}/2027-09-01.csv`, content: csv(SEPTEMBER) }],
    prompt: `Build yourself a reusable tool named ${TOOL}: given the path of a shipping manifest CSV with the
columns sku,qty,unit_weight_kg, it returns the manifest's total quantity and its total weight in kg
(quantity times unit weight, summed), rounded to 2 decimals. Then use it on ${DIR}/2027-09-01.csv and
reply with one line: the total quantity, a space, and the total weight.`,
    verify: async (verifier) => {
      await verifier.check('the-tool-is-listed', async () => {
        const tools = await verifier.tools();

        return { pass: tools.some((tool) => tool.name === TOOL),
          evidence: { tools: tools.map((tool) => ({ name: tool.name, usageCount: tool.usageCount ?? 0 })) } };
      });

      await checkTotals(verifier, 'answers-with-the-totals', SEPTEMBER);
    },
  }, {
    seed: [{ path: `${DIR}/2027-10.zip`, content: zip([...OCTOBER, RESENT].map((file) => ({ name: file.name, content: csv(file.lines) }))) }],
    prompt: `A month later our forwarder sent October's manifests as one archive, ${DIR}/2027-10.zip. Unpack it into
${OCTOBER_DIR}/. The forwarder sometimes re-sends a manifest we already have under a new name; keep no copy of
one already in ${DIR}. Then use your ${TOOL} tool on each October manifest and reply with one line: October's
total quantity across them, a space, and its total weight.`,
    verify: async (verifier) => {
      // Exactly October's two, so the re-sent copy is not kept, and each byte for byte as it was zipped.
      await verifier.check('unpacks-octobers-manifests-and-no-copy', async () => {
        const listed = (await verifier.files(OCTOBER_DIR)).filter((entry) => entry.type === 'file').map((entry) => entry.name).sort();
        const changed: string[] = [];

        for (const file of OCTOBER) {
          if (listed.includes(file.name) && await verifier.readFile(`${OCTOBER_DIR}/${file.name}`) !== csv(file.lines)) changed.push(file.name);
        }

        return { pass: listed.join('\n') === OCTOBER.map((file) => file.name).sort().join('\n') && changed.length === 0, evidence: { listed, changed } };
      });

      await checkTotals(verifier, 'answers-with-octobers-totals', OCTOBER.flatMap((file) => file.lines));

      // The product records reviewed turns, not invocations within one eval block.
      await verifier.check('reuses-the-tool-it-built', async () => {
        const before = v.parse(v.object({ tools: v.array(ToolTurnUseSchema) }), verifier.earlierCheck('the-tool-is-listed')?.evidence).tools;
        const after = await verifier.tools();

        return {
          pass: reusedInLaterTurn(before, after, TOOL),
          evidence: { before, after: after.map((tool) => ({ name: tool.name, usageCount: tool.usageCount ?? 0 })) },
        };
      });
    },
  }, {
    prompt: `Our tools run on ${PACKAGES.join(', ')}. What are the latest versions npm publishes of each? Look them up
now rather than recalling them. Reply with one line per package: the package name, a space, and its version.`,
    verify: async (verifier) => {
      for (const name of PACKAGES) {
        await verifier.check(`gives-the-registrys-latest-${name}`, async () => {
          const expected = (await published(name)).version;
          const answer = answered(verifier.replies, name);

          return { pass: answer === expected, evidence: { answer, expected, replies: verifier.recentReplies() } };
        });
      }
    },
  }],
});

defineTaskEval(task);
