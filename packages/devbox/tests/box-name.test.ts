// D96: the box answers to the name its class gives it, one DNS label, resolved by the box itself. Naming never refuses a
// start (D92: staging 7e411119d wrote /etc/hostname, read-only on the platform, and every start failed). The real
// platform is the container tier's `box-name` step.
import { TestDevbox } from './support/test-devbox';
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';

import { harness } from './support/devbox-harness';

class NamedBox extends TestDevbox<unknown> {
  protected override get ambientCheckpoints(): boolean { return false; }

  protected override async hostname(): Promise<string> {
    return 'storefront';
  }
}

const Unresolved = v.object({ event: v.literal('devbox.name.unresolved'), name: v.string(), detail: v.string() });

const traced: string[] = [];

const console$ = spyOn(console, 'log').mockImplementation((line: string) => { traced.push(line); });

afterEach(() => { traced.length = 0; });

process.on('exit', () => console$.mockRestore());

/** The box's `devbox.name.unresolved` lines, as its trace prints them. */
const unresolved = () => traced.flatMap((line) => {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), Unresolved), line);

  return parsed.success ? [parsed.output] : [];
});

test('a box takes its name as it starts, and says nothing when the name resolves', async () => {
  const { box, container } = harness(NamedBox);
  await box.devboxStartup();

  expect(container.sequence).toContain('name:storefront');
  expect((await box.exec('true')).exitCode).toBe(0);
  expect(unresolved()).toEqual([]);
});

test('a name that does not resolve still starts the box, and says what it found', async () => {
  const { box, container } = harness(NamedBox);
  container.nameBox = { stdout: 'named=no unresolved\n', stderr: '', exitCode: 0 };
  await box.devboxStartup();

  expect((await box.exec('true')).exitCode).toBe(0);
  expect(unresolved()).toEqual([expect.objectContaining({ name: 'storefront', detail: expect.stringContaining('unresolved') })]);
});

test('a container that refuses the naming outright still starts the box', async () => {
  const { box, container } = harness(NamedBox);
  container.nameBox = 'gone';
  await box.devboxStartup();

  expect((await box.exec('true')).exitCode).toBe(0);
  expect(unresolved()).toHaveLength(1);
});
