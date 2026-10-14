// D93: a person sees the box by its workspace's name; the kernel keeps the platform's. Keeping the name never refuses a
// start (D92: staging 7e411119d wrote /etc/hostname, read-only on the platform, and every start failed). The real
// platform is the container tier's `box-name` step.
import { TestDevbox } from './support/test-devbox';
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';

import { harness } from './support/devbox-harness';

class NamedBox extends TestDevbox<unknown> {
  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override async shownName(): Promise<string> {
    return 'storefront';
  }
}

const Unshown = v.object({ event: v.literal('devbox.name.unshown'), name: v.string(), detail: v.string() });

const traced: string[] = [];

const console$ = spyOn(console, 'log').mockImplementation((line: string) => { traced.push(line); });

afterEach(() => { traced.length = 0; });

process.on('exit', () => console$.mockRestore());

/** The box's `devbox.name.unshown` lines, as its trace prints them. */
const unshown = () => traced.flatMap((line) => {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), Unshown), line);

  return parsed.success ? [parsed.output] : [];
});

test('a box keeps its shown name as it starts, and says nothing when it took', async () => {
  const { box, container } = harness(NamedBox);

  await box.devboxStartup();

  expect(container.sequence).toContain('name:storefront');
  expect((await box.exec('true')).exitCode).toBe(0);
  expect(unshown()).toEqual([]);
});

test('a name the box cannot keep leaves its prompts the platform host, starts it, and says why', async () => {
  const { box, container } = harness(NamedBox);
  container.showName = { stdout: '', stderr: 'sh: 1: cannot create /etc/devbox-shown-name: Read-only file system', exitCode: 2 };

  await box.devboxStartup();

  expect((await box.exec('true')).exitCode).toBe(0);
  expect(unshown()).toEqual([expect.objectContaining({ name: 'storefront', detail: expect.stringContaining('Read-only') })]);
});

test('a container that refuses the write outright still starts the box', async () => {
  const { box, container } = harness(NamedBox);
  container.showName = 'gone';

  await box.devboxStartup();

  expect((await box.exec('true')).exitCode).toBe(0);
  expect(unshown()).toHaveLength(1);
});
