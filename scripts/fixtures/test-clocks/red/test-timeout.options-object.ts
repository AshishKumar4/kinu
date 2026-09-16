// The same duration as an option, on a hook and on a case.
import { beforeAll, test } from 'bun:test';

beforeAll(async () => { await Promise.resolve(); }, 20_000);

test('a case', async () => { await Promise.resolve(); }, { timeout: 60_000 });
