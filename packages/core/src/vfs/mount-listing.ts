/** `df`, `mount` and `/proc/mounts` over the shell's mount table; Nimbus lists only its root. A mount's size is `-`. */

import type { Command, CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { VFS } from '../types/primitives';
import { EXECUTOR_MOUNTS, withMountTable, type MountedVfs, type VfsMountRouting } from './mounts';

interface MountListingEntry {
  readonly source: string;
  readonly point: string;
  readonly type: string;
  readonly options: 'rw' | 'ro';
}

type MountListingTable = (cred: Readonly<VfsCred>) => VfsMountRouting | null;

interface RootUsage {
  readonly usedBytes: number;
  readonly capacityBytes: number;
}

type Units = 'blocks' | 1024 | 1000;

function sized(bytes: number, human: Units): string {
  if (human === 'blocks') return String(Math.ceil(bytes / 1024));

  const [value, unit] = ([[human ** 3, 'G'], [human ** 2, 'M'], [human, 'K']] as const).find(([scale]) => bytes >= scale) ?? [1, ''];

  return `${(bytes / value).toFixed(value === 1 ? 0 : 1)}${unit}`;
}

function figures(usage: RootUsage | null, human: Units): string[] {
  if (usage === null) return ['-', '-', '-', '-'];
  const available = Math.max(0, usage.capacityBytes - usage.usedBytes);
  const percent = usage.capacityBytes === 0 ? 0 : Math.ceil((usage.usedBytes / usage.capacityBytes) * 100);

  return [sized(usage.capacityBytes, human), sized(usage.usedBytes, human), sized(available, human), `${String(percent)}%`];
}

const DEVICE_MOUNT = EXECUTOR_MOUNTS.device.slice(1);

async function mountListing(table: VfsMountRouting | null): Promise<MountListingEntry[]> {
  const root: MountListingEntry = { source: 'nimbus', point: '/', type: 'nimbus-sqlite', options: 'rw' };

  const mounts = await Promise.all((table?.liveMounts() ?? []).map(async (live): Promise<MountListingEntry[]> => {
    const options = live.readOnly ? 'ro' : 'rw';

    if (live.name !== DEVICE_MOUNT) return [{ source: live.name, point: `/${live.name}`, type: 'kinu', options }];

    return (await live.files.readdir('/')).map((machine) => ({ source: machine, point: `/${live.name}/${machine}`, type: 'kinu-device', options }));
  }));

  return [root, ...mounts.flat().sort((a, b) => a.point.localeCompare(b.point))];
}

function procMounts(entries: readonly MountListingEntry[]): string {
  return entries.map((entry) => `${entry.source} ${entry.point} ${entry.type} ${entry.options} 0 0\n`).join('');
}

function holding(entries: readonly MountListingEntry[], path: string): MountListingEntry | undefined {
  return entries
    .filter((entry) => entry.point === '/' || path === entry.point || path.startsWith(`${entry.point}/`))
    .sort((a, b) => b.point.length - a.point.length)[0];
}

function columns(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, index) => Math.max(...rows.map((row) => row[index]?.length ?? 0))) ?? [];

  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join(' ')).join('\n');
}

async function df(ctx: CommandContext, table: MountListingTable, root: () => RootUsage): Promise<number> {
  const flags = ctx.args.filter((arg) => arg.startsWith('-') && arg !== '-');
  const operands = ctx.args.filter((arg) => !flags.includes(arg));
  const letters = flags.flatMap((flag) => flag.slice(1).split(''));
  const unknown = letters.find((letter) => !'ahHkTl'.includes(letter));

  if (unknown !== undefined) {
    await ctx.stderr.write(`df: invalid option -- '${unknown}'\n`);

    return 1;
  }

  let units: Units = 'blocks';

  if (letters.includes('h')) units = 1024;

  if (letters.includes('H')) units = 1000;
  const typed = letters.includes('T');
  const entries = await mountListing(table(ctx.cred));
  const shown: MountListingEntry[] = [];

  for (const operand of operands) {
    const absolute = operand.startsWith('/') ? operand : `${ctx.cwd.replace(/\/$/u, '')}/${operand}`;
    const entry = holding(entries, absolute);

    if (entry !== undefined && !shown.includes(entry)) shown.push(entry);
  }

  const human = units !== 'blocks';
  const header = ['Filesystem', ...(typed ? ['Type'] : []), human ? 'Size' : '1K-blocks', 'Used', human ? 'Avail' : 'Available', 'Use%', 'Mounted on'];

  const rows = (operands.length > 0 ? shown : entries).map((entry) => [
    entry.source, ...(typed ? [entry.type] : []), ...figures(entry.point === '/' ? root() : null, units), entry.point,
  ]);

  await ctx.stdout.write(`${columns([header, ...rows])}\n`);

  return 0;
}

async function mount(ctx: CommandContext, table: MountListingTable): Promise<number> {
  if (ctx.args.length > 0) {
    await ctx.stderr.write('mount: this workspace\'s mounts are fixed; mount lists them and takes no arguments\n');

    return 1;
  }

  const entries = await mountListing(table(ctx.cred));

  await ctx.stdout.write(entries.map((entry) => `${entry.source} on ${entry.point} type ${entry.type} (${entry.options})\n`).join(''));

  return 0;
}

export function mountCommands(table: MountListingTable, root: () => RootUsage): Readonly<Record<'df' | 'mount', Command>> {
  return {
    df: async (ctx) => await df(ctx, table, root),
    mount: async (ctx) => await mount(ctx, table),
  };
}

export type ProcMutations = Pick<VFS, 'writeFile' | 'unlink' | 'mkdir'>;

export function procMountsPlane(table: VfsMountRouting | null, kernel: ProcMutations): MountedVfs {
  let listed: Promise<Uint8Array> | undefined;
  const bytes = (): Promise<Uint8Array> => (listed ??= mountListing(table).then((entries) => new TextEncoder().encode(procMounts(entries))));

  const files: VFS & { readRange(path: string, offset: number, length: number): Promise<Uint8Array> } = {
    ...kernel,
    readFile: async (_path, opts) => (opts?.encoding === undefined ? await bytes() : new TextDecoder().decode(await bytes())),
    readRange: async (_path, offset, length) => (await bytes()).slice(offset, offset + length),
    stat: async () => ({ size: (await bytes()).length, mtimeMs: 0, isDir: false }),
    exists: async () => true,
    readdir: async () => [],
  };

  return withMountTable(files, [{ name: 'proc', files: () => files, absentReason: () => 'never absent', filesOwner: 'agent', readOnly: true }]);
}
