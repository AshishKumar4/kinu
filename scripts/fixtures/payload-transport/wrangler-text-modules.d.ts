/**
 * Types the wrangler Text rule, so the raw-text import needs no suppression.
 *
 * `wrangler.jsonc` declares `{ "type": "Text", "globs":
 * ["**\/container-harness.bundle.txt"] }`. That rule makes the bundler turn the
 * file into a module whose default export is the file's contents as a string.
 * TypeScript cannot see bundler rules, so the import used to carry a
 * `@ts-expect-error`.
 *
 * A suppression was the wrong tool twice over. It erased the diagnostic instead
 * of answering it, leaving `HARNESS_TS` implicitly `any` at the one place the
 * harness bytes enter the Worker; and `@ts-expect-error` asserts only that SOME
 * error exists on the next line, so the import would keep passing if the
 * specifier were later misspelled into a genuinely missing module. Declaring the
 * module gives the import its real type — `string`, which is what
 * `writeFile(HARNESS_PATH, HARNESS_TS)` requires — and restores the missing-module
 * error for every specifier the bundler does not actually resolve.
 */
declare module '*.bundle.txt' {
  const contents: string;
  export default contents;
}
