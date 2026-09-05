/**
 * The gadget manifest — what an agent-written app declares before any of its
 * code runs.
 *
 * A gadget is a directory under `gadgets/` in the workspace: `gadget.json`
 * (this manifest), `server.js` (a Durable Object class the host runs in a
 * dynamic-worker facet with no network) and `client.js` (a module the host
 * runs in a sandboxed iframe with no network). The manifest is the half a
 * host, a reviewer or a test can read without executing anything: the title
 * the tab wears and the bindings the server may reach. That split is the
 * FacetManifest / runtime-class split of agent-core SPEC §4.1, and it is what
 * makes a gadget's reach inspectable as data.
 *
 * Bindings are the whole of what a server can reach. Each entry is a
 * capability the workspace introduces under a name the code addresses as
 * `env.<NAME>`; the host mints exactly these into the isolate and nothing
 * else (SPEC §4.7, `C13-AUTH-ISOLATE-NAMESPACE-CLOSED`). The kinds are closed:
 *
 *   files      a directory of the workspace file plane, rooted at `root`
 *   workspace  the closed list of read models in `sources.ts`
 *   mcp        one MCP connection the owner configured, every call judged by
 *              the approval gate (`gatekeeper.ts`)
 *
 * Validation is fail-closed: `v.strictObject` rejects unknown keys rather
 * than stripping them, so a manifest written against a vocabulary this file
 * does not have is an error the model sees, not a gadget with a binding it
 * silently lacks.
 */

import * as v from 'valibot';
import { renderIssues } from '../utils/json';

/** Where gadgets live, relative to the workspace root. */
export const GADGET_DIR = 'gadgets';
export const GADGET_MANIFEST_FILE = 'gadget.json';
export const GADGET_SERVER_FILE = 'server.js';
export const GADGET_CLIENT_FILE = 'client.js';
export const GADGET_CLIENT_STYLE_FILE = 'client.css';

/** The class `server.js` exports and the host instantiates as the facet. */
export const GADGET_SERVER_CLASS = 'Gadget';

/** Bounds, in UTF-16 code units as `String.length` counts them. Each is a
 *  denial-of-service answer: the host reads these files into an isolate and a
 *  document, and a manifest names what it mints. */
export const GADGET_LIMITS = {
  slugChars: 40,
  titleChars: 60,
  subtitleChars: 120,
  bindings: 8,
  bindingNameChars: 32,
  serverChars: 512 * 1024,
  clientChars: 1024 * 1024,
  manifestChars: 8 * 1024,
} as const;

/** The directory name is the slug: lowercase, digits and hyphens, starting
 *  with a letter or digit. Fixed here because the slug travels into a facet
 *  name, a loader id and a surface kind, none of which may carry a path. */
const SLUG_RE = new RegExp(`^[a-z0-9][a-z0-9-]{0,${GADGET_LIMITS.slugChars - 1}}$`);

export function isGadgetSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** A binding name is what `env.<NAME>` spells in `server.js`. Upper snake
 *  case, the convention every Workers binding already follows. */
const BINDING_NAME_RE = new RegExp(`^[A-Z][A-Z0-9_]{0,${GADGET_LIMITS.bindingNameChars - 1}}$`);

/** A workspace-relative directory: no leading slash, no `.`/`..` segment, no
 *  empty segment. The file plane resolves it under the workspace root. */
const RELATIVE_DIR_RE = /^(?!\.{1,2}(\/|$))[^/\0]+(\/(?!\.{1,2}(\/|$))[^/\0]+)*$/;

const relativeDir = v.pipe(
  v.string(),
  v.maxLength(200),
  v.regex(RELATIVE_DIR_RE, 'root must be a workspace-relative directory with no . or .. segment'),
);

const McpToolName = v.pipe(v.string(), v.minLength(1), v.maxLength(80));

const FilesBinding = v.strictObject({
  kind: v.literal('files'),
  /** Defaults to `gadgets/<slug>/data` — a gadget's own corner of the tree. */
  root: v.optional(relativeDir),
});

const WorkspaceBinding = v.strictObject({
  kind: v.literal('workspace'),
});

const McpBinding = v.strictObject({
  kind: v.literal('mcp'),
  /** The configured MCP server's id, as the owner's connection list names it. */
  server: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  /** The tools the gadget may call. Absent means every tool the server
   *  offers; present, the list is the whole of what the binding answers. */
  tools: v.optional(v.pipe(v.array(McpToolName), v.maxLength(64))),
});

const GadgetBindingSchema = v.variant('kind', [FilesBinding, WorkspaceBinding, McpBinding]);

export type GadgetBinding = v.InferOutput<typeof GadgetBindingSchema>;
export type GadgetBindingKind = GadgetBinding['kind'];
export type GadgetFilesBinding = Extract<GadgetBinding, { kind: 'files' }>;
export type GadgetMcpBinding = Extract<GadgetBinding, { kind: 'mcp' }>;

/** ASCII titles only: `normalizeGadgetTitle` folds to ASCII letters and
 *  digits, and a Cyrillic `а` would vanish in the fold and pass the reserved
 *  check while reading as a host surface's name. */
const asciiTitle = (max: number) => v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(max),
  v.regex(/^[\x20-\x7E]+$/, 'must be printable ASCII'),
);

const GadgetManifestSchema = v.strictObject({
  v: v.literal(1),
  title: v.pipe(
    asciiTitle(GADGET_LIMITS.titleChars),
    v.check(
      (title) => !RESERVED_GADGET_TITLES.includes(normalizeGadgetTitle(title)),
      'the host owns a surface by this name; a gadget tab may not wear it',
    ),
  ),
  subtitle: v.optional(asciiTitle(GADGET_LIMITS.subtitleChars)),
  bindings: v.optional(v.pipe(
    v.record(
      v.pipe(v.string(), v.regex(BINDING_NAME_RE, `a binding name is UPPER_SNAKE_CASE, at most ${GADGET_LIMITS.bindingNameChars} characters`)),
      GadgetBindingSchema,
    ),
    v.check(
      (bindings) => Object.keys(bindings).length <= GADGET_LIMITS.bindings,
      `at most ${GADGET_LIMITS.bindings} bindings`,
    ),
  )),
});

export type GadgetManifest = v.InferOutput<typeof GadgetManifestSchema>;

export type GadgetManifestResult =
  | { ok: true; manifest: GadgetManifest }
  | { ok: false; error: string };

/**
 * Parse an untrusted value into a manifest.
 *
 * Run on every read, never cached as "valid when written": the file sits on
 * a plane the agent writes through the `file` tool and the shell, so what was
 * valid a turn ago says nothing about the bytes there now.
 */
export function parseGadgetManifest<Input>(input: Input): GadgetManifestResult {
  const result = v.safeParse(GadgetManifestSchema, input);
  if (!result.success) {
    return { ok: false, error: `gadget.json invalid — ${renderIssues(result.issues)}` };
  }
  return { ok: true, manifest: result.output };
}

/** The bindings a manifest declares, as `[name, binding]` pairs in the order
 *  written. One accessor, so every consumer treats an absent map as empty. */
export function gadgetBindings(manifest: GadgetManifest): ReadonlyArray<readonly [string, GadgetBinding]> {
  return Object.entries(manifest.bindings ?? {});
}

/** Where a `files` binding is rooted: its own `root`, or the gadget's data
 *  directory. Resolved in one place so the isolate's props and the host's
 *  path check cannot disagree. */
export function gadgetFilesRoot(slug: string, binding: GadgetFilesBinding): string {
  return binding.root ?? `${GADGET_DIR}/${slug}/data`;
}

/**
 * Surface names the host owns. A gadget may not take one as its title: agent
 * tabs already render in a marked group, but a tab reading "Releases" beside
 * the real Releases tab is a spoof the marker alone does not answer.
 *
 * NOTHING IS EVER REMOVED FROM THIS LIST. A name the host has retired is more
 * dangerous than one it still uses, not less: the returning user's muscle
 * memory still reaches for it, and an agent-authored tab wearing it would be
 * answered with exactly the trust the retired surface had earned. `tasks`,
 * `jobs`, `changelog` and `self` are all retired host names kept here forever
 * for that reason.
 *
 * `cf-backend/tests/unit-gadget-sources.test.ts` asserts a manifest titled
 * after any member of the UI's `SURFACES` tuple is refused — so a new host
 * surface cannot quietly become impersonable — and that every retired name
 * still is.
 */
const RESERVED_GADGET_TITLES: readonly string[] = [
  // Live host surfaces.
  'output',
  'work',
  'files',
  'releases',
  'exploration',
  'agent',
  'environment',
  'activity',
  // Retired host surface names. Kept forever — see the note above.
  'self',
  'tasks',
  'jobs',
  'changelog',
  'evolutionchangelog',
  'brain',
  'reasoning',
  // Host chrome an agent tab must never impersonate.
  'approvals',
  'approval',
  'consent',
  'consents',
  'credentials',
  'settings',
  'signin',
  'login',
];

/** Fold a title to the form `RESERVED_GADGET_TITLES` is keyed by. The fold
 *  keeps ASCII letters and digits only; the schema refuses non-ASCII titles
 *  before it folds. */
function normalizeGadgetTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}
