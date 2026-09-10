/**
 * The C3 overwrite cell: bytes put per 64 KiB overwrite stays within a small
 * constant of the edit.
 *
 * A matched-controls cell, not a unit test: it reads one case's
 * `stdout.ndjson` from the matched-chain harness (the same harness as the
 * blank-cells run) and asserts every overwrite publication uploaded at most
 * the bound. The bound is what the chunked-delta design can reach: a 64 KiB
 * edit touches at most two 64 KiB blocks, so the patch carries at most
 * 128 KiB plus the manifest and image skeleton. 196,608 bytes is three times
 * the edit size.
 *
 * Usage: bun scripts/bench-c3-overwrite-cell.ts <stdout.ndjson> [bound]
 * Exit 0 when every round is within bound and the case is correct, else 1.
 */
import { readFileSync } from "node:fs";
import * as v from "valibot";

const path = Bun.argv[2];
if (path === undefined) {
  process.stderr.write("usage: bun scripts/bench-c3-overwrite-cell.ts <stdout.ndjson> [bound]\n");
  process.exit(2);
}
const bound = Bun.argv[3] === undefined ? 196_608 : Number(Bun.argv[3]);
if (!Number.isFinite(bound) || bound <= 0) {
  process.stderr.write(`bound must be a positive number, got ${Bun.argv[3] ?? ""}\n`);
  process.exit(2);
}
const ObservationSchema = v.object({
  event: v.literal("matched.chain.C3.observations"),
  case: v.string(),
  rounds: v.array(
    v.object({
      round: v.number(),
      published: v.object({
        transport: v.object({ puts: v.number(), putUploadBytes: v.number() }),
      }),
    }),
  ),
});
const CompletionSchema = v.object({
  event: v.literal("matched.chain.complete"),
  correctness: v.optional(v.string()),
});
const observations: v.InferOutput<typeof ObservationSchema>[] = [];
let completion: v.InferOutput<typeof CompletionSchema> | undefined;
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.startsWith("{")) continue;
  const parsed = JSON.parse(line);
  const observation = v.safeParse(ObservationSchema, parsed);
  if (observation.success) {
    observations.push(observation.output);
    continue;
  }
  const completionRow = v.safeParse(CompletionSchema, parsed);
  if (completionRow.success) completion = completionRow.output;
}
if (observations.length !== 1 || observations[0] === undefined) {
  process.stderr.write(`expected one C3 observation row in ${path}\n`);
  process.exit(1);
}
const row = observations[0];
let failed = false;
if (completion?.correctness !== "passed") {
  process.stderr.write(`${row.case}: correctness is ${completion?.correctness ?? "missing"}, not passed\n`);
  failed = true;
}
for (const round of row.rounds) {
  const uploaded = round.published.transport.putUploadBytes;
  const puts = round.published.transport.puts;
  const status = uploaded <= bound ? "within" : "OVER";
  process.stdout.write(
    `${row.case} round ${round.round}: ${uploaded} bytes in ${puts} PUTs vs bound ${bound} — ${status}\n`,
  );
  if (uploaded > bound) failed = true;
}
process.exit(failed ? 1 : 0);
