import { WORKSPACE_ROOT } from '@kinu.run/core';
import { defineEvalTask, type SeedFile } from '../src/task';
import type { EvalVerifier } from '../src/verifier';
import { Seeded } from './seeded';

// An inbox of dropped files: invoices, photos, notes, and two copies of files already there. The
// agent tidies it the way it is asked. Graded on what the Files tab lists afterwards and on every
// kept file's content, byte for byte what was dropped in.

const MISSION = "Tern Street Deli's workspace. Deliveries, invoices and photos of the stock land in our inbox.";

type Kind = 'invoice' | 'photo' | 'note';

type Dropped = { name: string; kind: Kind; content: string; copyOf?: string };

function body(random: Seeded, kind: Kind, name: string): string {
  if (kind === 'invoice') {
    return `INVOICE ${name}\nSupplier: ${random.pick(['Brightwell Dairy', 'Kestrel Mills', 'Coastline Fish'])}\n`
      + `Total: ${(random.int(4_000, 180_000) / 100).toFixed(2)} USD\n`;
  }

  if (kind === 'photo') return `photo ${name} ${Array.from({ length: 24 }, () => random.int(0, 9)).join('')}\n`;

  return `${name}\n- ${random.pick(['order more rye', 'call the fish supplier', 'fix the slicer'])}\n`;
}

function dropped(): Dropped[] {
  const random = new Seeded(0x7e44);

  const files: Dropped[] = [
    ...['invoice-2027-0412.pdf', 'invoice-2027-0419.pdf', 'INV_Kestrel_0426.pdf'].map((name) => ({ name, kind: 'invoice' as const })),
    ...['IMG_2041.jpg', 'IMG_2042.jpg', 'delivery-dock.png'].map((name) => ({ name, kind: 'photo' as const })),
    ...['todo.txt', 'supplier-contacts.md'].map((name) => ({ name, kind: 'note' as const })),
  ].map((file) => ({ ...file, content: body(random, file.kind, file.name) }));

  const copy = (of: string, name: string): Dropped => {
    const original = files.find((file) => file.name === of);

    if (original === undefined) throw new Error(`no ${of} to copy`);

    return { ...original, name, copyOf: of };
  };

  return [...files, copy('IMG_2041.jpg', 'IMG_2041 (1).jpg'), copy('invoice-2027-0412.pdf', 'invoice-2027-0412 copy.pdf')];
}

const DROPPED = dropped();

const SEED: readonly SeedFile[] = DROPPED.map((file) => ({ path: `${WORKSPACE_ROOT}/inbox/${file.name}`, content: file.content }));

const kept = (kind: Kind): readonly Dropped[] => DROPPED.filter((file) => file.kind === kind && file.copyOf === undefined);

/** The folder lists exactly `files`, and each holds what was dropped in. */
async function holdsExactly(verifier: EvalVerifier, id: string, dir: string, files: readonly Dropped[]): Promise<void> {
  await verifier.check(id, async () => {
    const listed = (await verifier.files(dir)).filter((entry) => entry.type === 'file').map((entry) => entry.name).sort();
    const expected = files.map((file) => file.name).sort();
    const changed: string[] = [];

    for (const file of files) {
      if (listed.includes(file.name) && await verifier.readFile(`${dir}/${file.name}`) !== file.content) changed.push(file.name);
    }

    return { pass: listed.join('\n') === expected.join('\n') && changed.length === 0, evidence: { listed, expected, changed } };
  });
}

export const fileHousekeeping = defineEvalTask({
  id: 'file-housekeeping',
  mission: MISSION,
  turns: [{
    seed: SEED,
    prompt: `Tidy up inbox/. Move every invoice into archive/invoices/ and every photo into archive/photos/,
keeping their file names. A file that is an exact duplicate of another one, the same content, goes: keep
the copy without " (1)" or " copy" in its name. Leave the notes in inbox/ where they are.`,
    verify: async (verifier) => {
      await holdsExactly(verifier, 'invoices-are-archived', `${WORKSPACE_ROOT}/archive/invoices`, kept('invoice'));
      await holdsExactly(verifier, 'photos-are-archived', `${WORKSPACE_ROOT}/archive/photos`, kept('photo'));
      await holdsExactly(verifier, 'only-the-notes-stay-in-the-inbox', `${WORKSPACE_ROOT}/inbox`, kept('note'));
    },
  }],
});
