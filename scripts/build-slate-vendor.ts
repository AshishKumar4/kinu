// Writes the slate vendor's bytes to the file named on the command line, by rename. The bun test preload runs
// this in a process of its own, so the esbuild service the build starts ends with that process, not a test's.
import { renameSync, writeFileSync } from 'node:fs';
import { buildSlateVendor } from '../packages/cf-backend/slate-vendor';

const [file] = process.argv.slice(2);

if (file === undefined) throw new Error('usage: bun scripts/build-slate-vendor.ts <file>');

const temporary = `${file}.${String(process.pid)}.tmp`;

writeFileSync(temporary, JSON.stringify(buildSlateVendor()));

renameSync(temporary, file);
