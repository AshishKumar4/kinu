/**
 * The gadget manifest — what an agent-written app declares before any of its
 * code runs.
 *
 * A gadget is a directory under `gadgets/` in the workspace: `gadget.json`
 * (this manifest), `server.js` (a Cap'n Web `RpcTarget` the resident process
 * hosts with `env` and nothing else) and `client.js` (a module the host
 * runs in a sandboxed iframe with no network). The manifest is the half a
 * host, a reviewer or a test can read without executing anything: the title
 * the tab wears and the bindings the server may reach. That split is the
 * FacetManifest / runtime-class split of agent-core SPEC §4.1, and it is what
 * makes a gadget's reach inspectable as data.
 *
 * The server shape is fixed: `server.js` imports `RpcTarget` from `./capnweb.js`
 * and exports `class Gadget extends RpcTarget` with
 * `constructor(env) { super(); this.env = env; }`. Each prototype method is a
 * JSON RPC method. User code receives no `ctx` and no SQLite.
 *
 * Bindings are the whole of what a server can reach. Each entry passes ONE of
 * the agent's own capabilities into the process under a name the code
 * addresses as `env.<NAME>.<member>(...args)`; the host places exactly these
 * into the resident process env and nothing else (SPEC §4.7,
 * `C13-AUTH-ISOLATE-NAMESPACE-CLOSED`). A binding passes the capability gated
 * exactly as the agent's own call is, and no more: there is no binding-specific
 * approval rule. The four planes:
 *
 *   namespace  a codemode namespace the workspace has (`workspace`, `sandbox`,
 *              `laptop`, `parent`, `web`, `memory`, `tasks`, `agents`, ...),
 *              every member or the listed ones
 *   rpc        the workspace object's own read models, each classed
 *              `workspace.read` (`sources.ts`), named one by one
 *   mcp        one MCP connection the owner configured, every tool or the
 *              listed ones
 *   app        another gadget's server, over the same call path
 *
 * Validation is fail-closed: `v.strictObject` rejects unknown keys rather
 * than stripping them, so a manifest written against a vocabulary this file
 * does not have is an error the model sees, not a gadget with a binding it
 * silently lacks. Whether the workspace HAS a namespace or a connection is a
 * call-time answer: the manifest only says what the app asks for.
 */

import * as v from 'valibot';
import { renderIssues } from '../utils/json';
import { GADGET_DATA_SOURCES } from './sources';

/** Where gadgets live, relative to the workspace root. */
export const GADGET_DIR = 'gadgets';
export const GADGET_MANIFEST_FILE = 'gadget.json';
export const GADGET_SERVER_FILE = 'server.js';
export const GADGET_CLIENT_FILE = 'client.js';
export const GADGET_CLIENT_STYLE_FILE = 'client.css';

/** The class `server.js` exports and the resident process boots with `env`. */
export const GADGET_SERVER_CLASS = 'Gadget';

/** Bounds, in UTF-16 code units as `String.length` counts them, plus the one
 *  hop count. Each is a denial-of-service answer: the host reads these files
 *  into a resident process and a document, a manifest names what it mints,
 *  and an app that binds an app can close a cycle. */
export const GADGET_LIMITS = {
  slugChars: 40,
  titleChars: 60,
  subtitleChars: 120,
  bindings: 8,
  bindingNameChars: 32,
  serverChars: 512 * 1024,
  clientChars: 1024 * 1024,
  manifestChars: 8 * 1024,
  /** How many app-to-app hops one call may be down before the next is
   *  refused. A cycle is refused by this count, not by a registry. */
  appDepth: 8,
} as const;

/** The directory name is the slug: lowercase, digits and hyphens, starting
 *  with a letter or digit. Fixed here because the slug travels into a resident
 *  process name and a surface kind, neither of which may carry a path. */
const SLUG_RE = new RegExp(`^[a-z0-9][a-z0-9-]{0,${GADGET_LIMITS.slugChars - 1}}$`);

export function isGadgetSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** A binding name is what `env.<NAME>` spells in `server.js`. Upper snake
 *  case, the convention every Workers binding already follows. */
const BINDING_NAME_RE = new RegExp(`^[A-Z][A-Z0-9_]{0,${GADGET_LIMITS.bindingNameChars - 1}}$`);

/** A codemode namespace name as the sandbox spells it (`workspace`, `web`,
 *  `laptop`): lowercase, digits and underscores, starting with a letter. */
const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** A member the app may call on a binding: a provider tool, an MCP tool. Any
 *  non-empty name the target itself can spell; the target decides at call time. */
const MemberName = v.pipe(v.string(), v.minLength(1), v.maxLength(80));

const NamespaceBinding = v.strictObject({
  kind: v.literal('namespace'),
  namespace: v.pipe(v.string(), v.regex(NAMESPACE_RE, 'a namespace is a codemode name: lowercase letters, digits and underscores')),
  /** The members the binding answers. Absent means every member the
   *  provider has; present, the list is the whole of what the binding answers. */
  members: v.optional(v.pipe(v.array(MemberName), v.minLength(1), v.maxLength(64))),
});

const RpcBinding = v.strictObject({
  kind: v.literal('rpc'),
  /** The read models the binding answers, each one of the closed
   *  `workspace.read` list. A method of any other class fails here. */
  methods: v.pipe(
    v.array(v.picklist(
      GADGET_DATA_SOURCES,
      (issue) => `${issue.received} is not a read model an rpc binding may name; the workspace.read list is ${GADGET_DATA_SOURCES.join(', ')}`,
    )),
    v.minLength(1),
    v.maxLength(GADGET_DATA_SOURCES.length),
  ),
});

const McpBinding = v.strictObject({
  kind: v.literal('mcp'),
  /** The configured MCP server's id, as the owner's connection list names it. */
  server: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  /** The tools the gadget may call. Absent means every tool the server
   *  offers; present, the list is the whole of what the binding answers. */
  tools: v.optional(v.pipe(v.array(MemberName), v.maxLength(64))),
});

const AppBinding = v.strictObject({
  kind: v.literal('app'),
  /** The other gadget's slug. Whether it exists is a call-time answer. */
  id: v.pipe(v.string(), v.regex(SLUG_RE, 'an app id is a gadget slug: lowercase letters, digits and hyphens')),
});

const GadgetBindingSchema = v.variant('kind', [NamespaceBinding, RpcBinding, McpBinding, AppBinding]);

export type GadgetBinding = v.InferOutput<typeof GadgetBindingSchema>;
export type GadgetBindingKind = GadgetBinding['kind'];

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
