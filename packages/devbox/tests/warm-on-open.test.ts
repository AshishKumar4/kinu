import { expect, test } from 'bun:test';
import { chainBox } from './support/chain-box';

// The owner, 2026-10-25: "if the workspace ever provisioned a container ... loading the workspace should load the
// container in the background too. But containers should still be lazily loaded to avoid unnecessary wastage of compute."
test('a box that has run starts as its workspace opens, with its files; one that never ran stays unstarted', async () => {
  const unused = chainBox();
  await unused.box.warm();

  const used = chainBox();
  await used.box.devboxStartup();
  await used.box.writeFile('/workspace/kept.txt', 'kept');
  await used.box.quiesce();
  const opened = used.evict();
  await opened.warm();
  const armed = used.container.scheduleRows.some((row) => row.callback === 'devboxStartup');
  await opened.devboxStartup();

  expect({
    unused: { armed: unused.container.scheduleRows.some((row) => row.callback === 'devboxStartup'), running: unused.container.running.running },
    used: { armed, running: used.container.running.running, kept: (await opened.readFile('/workspace/kept.txt')).content },
  }).toEqual({
    unused: { armed: false, running: false },
    used: { armed: true, running: true, kept: 'kept' },
  });
});
