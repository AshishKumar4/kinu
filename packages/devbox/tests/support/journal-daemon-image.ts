import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

const ImageIdSchema = v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/u));

/** The build writes its immutable image ID. Worktrees never exchange a tag. */
export async function buildJournalDaemonImage(context: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'journal-image-'));
  try {
    const idPath = join(scratch, 'image-id');
    const child = Bun.spawn(['docker', 'build', '--iidfile', idPath, context], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Daemon image build exited ${code}:\n${stdout.slice(-2000)}\n${stderr.slice(-4000)}`);
    return v.parse(ImageIdSchema, (await readFile(idPath, 'utf8')).trim());
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
