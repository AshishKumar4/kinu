/**
 * lcov parse, merge, and re-anchor — the one implementation `bun run coverage`
 * and `bun run coverage:check` share. A second parser beside this one is how
 * the ratchet gate and the report end up disagreeing about the same file.
 *
 * The lcov tracefile format this parses is the record grammar every lcov
 * consumer speaks: `SF:` opens a file record, `DA:line,count` marks one
 * instrumented line, `FNDA:count,name` one function, `BRDA:line,block,branch,
 * count` one branch outcome, the `FNF/FNH/LF/LH/BRF/BRH` totals close their
 * section, and `end_of_record` closes the file.
 *
 * MERGE sums per-line and per-function counts for the same file, then
 * recomputes the section totals from the summed data — never trusting the
 * input's own `LF:` lines, because two inputs that disagree about a file's
 * total would then disagree forever. Branches merge per `line,block,branch`
 * key, taking the MAXIMUM hit count: the same branch executed in two runs
 * reports the larger truthfully, while summing it would double-count a
 * shared line for a suite pair that both execute it once.
 */

/** One `DA:` line. */
export interface LineDatum {
  readonly line: number;
  count: number;
}

/** One `FNDA:` function. */
export interface FunctionDatum {
  readonly name: string;
  count: number;
}

/** One `BRDA:` branch outcome. */
export interface BranchDatum {
  readonly line: number;
  readonly block: number;
  readonly branch: number;
  count: number;
}

export interface LcovTotals {
  found: number;
  hit: number;
}

/** One file record, with its data arrays and recomputable totals. */
export interface LcovRecord {
  /** Path as written in the source lcov — may be root-relative or absolute. */
  readonly file: string;
  readonly lines: { data: LineDatum[]; } & LcovTotals;
  readonly functions: { data: FunctionDatum[]; } & LcovTotals;
  readonly branches: { data: BranchDatum[]; } & LcovTotals;
  /** The record re-serialised exactly as this module would emit it. */
  readonly raw: string;
}

function serialize(
  file: string,
  lines: readonly LineDatum[],
  functions: readonly FunctionDatum[],
  branches: readonly BranchDatum[],
  declared: DeclaredTotals,
): string {
  const lineHits = lines.filter((d) => d.count > 0).length;
  const fnFound = functions.length > 0 ? functions.length : declared.functionsFound;
  const fnHits = functions.length > 0 ? functions.filter((d) => d.count > 0).length : declared.functionsHit;
  const brFound = branches.length > 0 ? branches.length : declared.branchesFound;
  const brHits = branches.length > 0 ? branches.filter((d) => d.count > 0).length : declared.branchesHit;
  let out = `TN:\nSF:${file}\n`;
  for (const fn of functions) out += `FNDA:${fn.count},${fn.name}\n`;
  out += `FNF:${fnFound}\nFNH:${fnHits}\n`;
  for (const da of lines) out += `DA:${da.line},${da.count}\n`;
  out += `LF:${lines.length}\nLH:${lineHits}\n`;
  for (const br of branches) out += `BRDA:${br.line},${br.block},${br.branch},${br.count}\n`;
  out += `BRF:${brFound}\nBRH:${brHits}\nend_of_record\n`;
  return out;
}

/**
 * The totals a producer DECLARED without the per-item records behind them.
 *
 * This is not a nicety. `bun test --coverage-reporter=lcov` (1.4.0) emits
 * `FNF:`/`FNH:` and no `FNDA:` at all, and emits NO branch section whatever;
 * `@vitest/coverage-istanbul` emits the full `FN`/`FNDA`/`BRDA` set. A parser
 * that counted functions only from `FNDA` therefore reported `-` for function
 * coverage on every bun package while reporting a real number for the two
 * workerd pools — a summary that reads measured and is blank where most of the
 * code lives. Declared totals are kept so the number exists, and merged by MAX
 * rather than summed, because the same file's declared totals repeat verbatim
 * across runs.
 */
interface DeclaredTotals {
  functionsFound: number;
  functionsHit: number;
  branchesFound: number;
  branchesHit: number;
}

/** Parse a full tracefile. Malformed lines throw with the line's text — a
 * parser that skips a shape it does not recognise would undercount silently,
 * which is exactly the failure class this module exists to prevent. */
export function parseLcov(text: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let file: string | undefined;
  let lines: LineDatum[] = [];
  let functions: FunctionDatum[] = [];
  let branches: BranchDatum[] = [];
  let declared: DeclaredTotals = { functionsFound: 0, functionsHit: 0, branchesFound: 0, branchesHit: 0 };

  const finish = (): void => {
    if (file === undefined) return;
    const fnFound = functions.length > 0 ? functions.length : declared.functionsFound;
    const fnHit = functions.length > 0 ? functions.filter((d) => d.count > 0).length : declared.functionsHit;
    const brFound = branches.length > 0 ? branches.length : declared.branchesFound;
    const brHit = branches.length > 0 ? branches.filter((d) => d.count > 0).length : declared.branchesHit;
    records.push({
      file,
      lines: { data: lines, found: lines.length, hit: lines.filter((d) => d.count > 0).length },
      functions: { data: functions, found: fnFound, hit: fnHit },
      branches: { data: branches, found: brFound, hit: brHit },
      raw: serialize(file, lines, functions, branches, declared),
    });
    file = undefined;
    lines = [];
    functions = [];
    branches = [];
    declared = { functionsFound: 0, functionsHit: 0, branchesFound: 0, branchesHit: 0 };
  };

  for (const line of text.split('\n')) {
    if (line === '' || line === 'TN:') continue;
    if (line.startsWith('SF:')) {
      finish();
      file = line.slice(3);
      continue;
    }
    if (line === 'end_of_record') {
      finish();
      continue;
    }
    if (file === undefined) throw new Error(`lcov line outside a record: ${line}`);
    if (line.startsWith('FNDA:')) {
      const match = /^FNDA:(\d+|-),(.*)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) throw new Error(`malformed FNDA: ${line}`);
      functions.push({ name: match[2], count: match[1] === '-' ? 0 : Number(match[1]) });
      continue;
    }
    if (line.startsWith('DA:')) {
      const match = /^DA:(\d+),(\d+|-)(?:,\S+)?$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) throw new Error(`malformed DA: ${line}`);
      lines.push({ line: Number(match[1]), count: match[2] === '-' ? 0 : Number(match[2]) });
      continue;
    }
    if (line.startsWith('BRDA:')) {
      const match = /^BRDA:(\d+),(\d+),(\d+),(\d+|-)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
        throw new Error(`malformed BRDA: ${line}`);
      }
      branches.push({
        line: Number(match[1]), block: Number(match[2]), branch: Number(match[3]),
        count: match[4] === '-' ? 0 : Number(match[4]),
      });
      continue;
    }
    const total = /^(FNF|FNH|BRF|BRH):(\d+)$/u.exec(line);
    if (total?.[1] !== undefined && total[2] !== undefined) {
      const value = Number(total[2]);
      if (total[1] === 'FNF') declared.functionsFound = value;
      if (total[1] === 'FNH') declared.functionsHit = value;
      if (total[1] === 'BRF') declared.branchesFound = value;
      if (total[1] === 'BRH') declared.branchesHit = value;
      continue;
    }
    // `LF:`/`LH:` are recomputed from the `DA:` records on emit, and `FN:` is
    // the function's declaration line, which the merge does not need.
    if (/^(LF|LH|FN):/u.test(line)) continue;
    throw new Error(`unrecognised lcov line: ${line}`);
  }
  finish();
  return records;
}

/**
 * Merge records for the same file across runs: line and function counts SUM,
 * branch counts take the max per branch key, totals recompute from the merged
 * data.
 *
 * DECLARED-ONLY sections (a producer that emitted `FNF`/`FNH` or `BRF`/`BRH`
 * with no per-item records — which is every bun group, see {@link
 * DeclaredTotals}) cannot be recomputed, because there is nothing to recompute
 * from. Those merge by MAX of found and MAX of hit: the same file's declared
 * totals repeat verbatim across runs, so summing would multiply them by the
 * number of groups that touched the file.
 */
export function mergeLcov(records: readonly LcovRecord[]): LcovRecord[] {
  const byFile = new Map<string, LcovRecord>();
  for (const record of records) {
    const existing = byFile.get(record.file);
    if (existing === undefined) {
      byFile.set(record.file, record);
      continue;
    }
    const lines = new Map<number, number>();
    for (const d of [...existing.lines.data, ...record.lines.data]) {
      lines.set(d.line, (lines.get(d.line) ?? 0) + d.count);
    }
    const functions = new Map<string, number>();
    for (const d of [...existing.functions.data, ...record.functions.data]) {
      functions.set(d.name, (functions.get(d.name) ?? 0) + d.count);
    }
    // Keyed by identity, VALUED by the datum, so the merged branch survives as
    // a record rather than as a string somebody has to parse back into three
    // numbers — which is the only reason this loop ever needed a cast.
    const branches = new Map<string, BranchDatum>();
    for (const b of [...existing.branches.data, ...record.branches.data]) {
      const id = `${b.line}:${b.block}:${b.branch}`;
      const prior = branches.get(id);
      branches.set(id, prior === undefined ? { ...b } : { ...b, count: Math.max(prior.count, b.count) });
    }
    const lineData = [...lines.entries()]
      .map(([line, count]) => ({ line, count }))
      .sort((a, b) => a.line - b.line);
    const functionData = [...functions.entries()].map(([name, count]) => ({ name, count }));
    const branchData = [...branches.values()]
      .sort((a, b) => a.line - b.line || a.block - b.block || a.branch - b.branch);
    const totals: DeclaredTotals = {
      functionsFound: functions.size > 0 ? functions.size
        : Math.max(existing.functions.found, record.functions.found),
      functionsHit: functions.size > 0 ? functionData.filter((d) => d.count > 0).length
        : Math.max(existing.functions.hit, record.functions.hit),
      branchesFound: branches.size > 0 ? branches.size
        : Math.max(existing.branches.found, record.branches.found),
      branchesHit: branches.size > 0 ? branchData.filter((d) => d.count > 0).length
        : Math.max(existing.branches.hit, record.branches.hit),
    };
    byFile.set(record.file, {
      file: record.file,
      lines: { data: lineData, found: lines.size, hit: lineData.filter((d) => d.count > 0).length },
      functions: { data: functionData, found: totals.functionsFound, hit: totals.functionsHit },
      branches: { data: branchData, found: totals.branchesFound, hit: totals.branchesHit },
      raw: serialize(record.file, lineData, functionData, branchData, totals),
    });
  }
  return [...byFile.values()];
}
