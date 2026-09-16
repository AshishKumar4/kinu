// The disabled default, and a clock read used as a value rather than compared.
import { setDefaultTimeout, test } from 'bun:test';

setDefaultTimeout(0);

test('an id carries the time it was minted', async () => {
  const id = `run-${String(Date.now())}`;
  await Promise.resolve(id);
});
