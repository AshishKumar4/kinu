/** The three `eval` programs a live eval (2026-10-02, run-7bde3ae0) sent to save `report_totals`, verbatim, with the
 *  error each met. The agent then concluded crafted tools cannot read files. */
export const RECORDED_ATTEMPTS = [
  {
    program: "// register report_totals as a reusable crafted tool\nconst fs = await import('fs');\nconst src = await fs.promises.readFile('/home/user/combinators/report-totals.js', 'utf8');\nconst code = src + `\nasync function main(args) {\n  return report_totals(args);\n}\nreturn await main(args);\n`;\nreturn await workspace.createTool(\n  'report_totals',\n  'Compute {total, passed, failed, skipped, durationMs} for a Jest-style CI JSON report at {path}',\n  code\n);",
    error: "Code execution failed: No such module \"node:fs\".",
  },
  {
    program: "// register report_totals as a reusable crafted tool\nconst fsp = require('fs/promises');\nconst src = await fsp.readFile('/home/user/combinators/report-totals.js', 'utf8');\nconst code = src + \"\\nasync function main(args) { return report_totals(args); }\\nreturn await main(args);\\n\";\nreturn await workspace.createTool(\n  'report_totals',\n  'Compute {total, passed, failed, skipped, durationMs} for a Jest-style CI JSON report at {path}',\n  code\n);",
    error: "createTool(\"report_totals\"): the tool source does not parse as JavaScript: 'return' outside of function (74:0). Write the tool as `async (args) => { ... }`, `async function name(args) { ... }`, or `const name = async (args) => { ... }`",
  },
  {
    program: "// register report_totals as a reusable crafted tool (function form)\nconst code = `const report_totals = async (args) => {\n  const fs = require('fs');\n  const SKIPPED = new Set(['pending', 'skipped', 'todo']);\n  const raw = fs.readFileSync(args.path, 'utf8');\n  const report = JSON.parse(raw);\n  const suites = Array.isArray(report && report.testResults) ? report.testResults : [];\n  const entries = suites.flatMap((s) => Array.isArray(s && s.assertionResults) ? s.assertionResults : []);\n  let passed = 0, failed = 0, skipped = 0, durationMs = 0;\n  for (const e of entries) {\n    const st = e && e.status;\n    if (st === 'passed') passed += 1;\n    else if (st === 'failed') failed += 1;\n    else if (typeof st === 'string' && SKIPPED.has(st)) skipped += 1;\n    durationMs += (e && typeof e.duration === 'number' && Number.isFinite(e.duration)) ? e.duration : 0;\n  }\n  return { total: entries.length, passed, failed, skipped, durationMs: Math.round(durationMs * 1000) / 1000 };\n};`;\nreturn await workspace.createTool(\n  'report_totals',\n  'Compute {total, passed, failed, skipped, durationMs} for a Jest-style CI JSON report at {path}',\n  code\n);",
    error: "Misevolution veto (unanalysable-code): the code hides what it names from this checklist (it does not parse, runs a string as code, imports at runtime, takes a constructor out of an object, or hands on the global object): write it with names the checklist can read Rewrite the tool body without it and call createTool again.",
  },
] as const;
