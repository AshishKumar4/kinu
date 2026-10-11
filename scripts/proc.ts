import * as fs from 'node:fs';
import { createProcReader } from '../packages/pc-agent/src/pty.js';

// ESM runners and the bundled CJS daemon use their own native fs module through the same implementation.
export const { procFile, procStat } = createProcReader(fs);
