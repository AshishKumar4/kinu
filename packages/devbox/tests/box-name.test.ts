// D92: naming the box never refuses it. Staging 7e411119d wrote /etc/hostname, which the platform mounts read-only,
// and every start failed; the real platform is the container tier's `box-name` step.
import { TestDevbox } from './support/test-devbox';
import { afterEach, expect, spyOn, test } from 'bun:test';

import * as v from 'valibot';

import { harness } from './support/devbox-harness';

class NamedBox extends TestDevbox<unknown> {
  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override async hostname(): Promise<string> {
    return 'storefront';
  }
}

const Kept = v.object({ event: v.literal('devbox.name.kept'), name: v.string(), detail: v.string() });

const traced: string[] = [];

const console$ = spyOn(console, 'log').mockImplementation((line: string) => { traced.push(line); });

afterEach(() => { traced.length = 0; });

process.on('exit', () => console$.mockRestore());

/** The box's `devbox.name.kept` lines, as its trace prints them. */
const kept = () => traced.flatMap((line) => {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), Kept), line);

  return parsed.success ? [parsed.output] : [];
});

test('a box names itself as it starts, and says nothing when the name took', async () => {
  const { box, container } = harness(NamedBox);

  await box.devboxStartup();

  expect(container.sequence).toContain('name:storefront');
  expect((await box.exec('true')).exitCode).toBe(0);
  expect(kept()).toEqual([]);
});

test('a name the platform will not take leaves the box its own name, starts it, and says why', async () => {
  const { box, container } = harness(NamedBox);
  container.nameBox = { stdout: 'named=no unresolved hosts=read-only\n', stderr: '', exitCode: 0 };

  await box.devboxStartup();

  expect((await box.exec('true')).exitCode).toBe(0);
  expect(kept()).toEqual([expect.objectContaining({ name: 'storefront', detail: 'named=no unresolved hosts=read-only' })]);
});

test('a naming the container refuses outright still starts the box', async () => {
  const { box, container } = harness(NamedBox);
  container.nameBox = 'gone';

  await box.devboxStartup();

  expect((await box.exec('true')).exitCode).toBe(0);
  expect(kept()).toHaveLength(1);
});
