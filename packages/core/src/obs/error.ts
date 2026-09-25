/**
 * Failure classification carried as a field, so readers need not match prose. `obs/` imports
 * nothing outside `obs/`; OOM signatures below are pinned to platform-catalog.ts by a test.
 */

import { classify, errnoCode, scalarText } from './expected-failure';

/**
 * Why an operation did not do what it was asked. `oom` stays distinct from `io`: it recurs on retry
 * (platform-catalog.ts do.isolate.oom_reported). Additive only: stored rows outlive the code.
 */
export const ERROR_CODES = [
  'bad_input',
  'denied',
  'unsupported',
  'budget',
  'unavailable',
  'missing',
  'timeout',
  'cancelled',
  'oom',
  'io',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Whether a failure class is the operation refusing (a decision) rather than breaking. */
export const CODE_IS_REFUSAL = {
  bad_input: true,
  denied: true,
  unsupported: true,
  budget: true,
  unavailable: false,
  missing: false,
  timeout: false,
  cancelled: false,
  oom: false,
  io: false,
} satisfies Readonly<Record<ErrorCode, boolean>>;

/**
 * Whether a failure class proves the work never started. `true` must be proof: a spent one-shot
 * grant is returned only on it (safety/deferred-approval.ts).
 */
export const CODE_WORK_DID_NOT_START = {
  bad_input: true,
  denied: true,
  unsupported: true,
  unavailable: true,
  budget: true,
  missing: false,
  timeout: false,
  cancelled: false,
  oom: false,
  /** The unclassified failure's answer; must stay `false`. */
  io: false,
} satisfies Readonly<Record<ErrorCode, boolean>>;

/** A classified failure; an ordinary `Error` chaining through native `cause`. */
export class KinuError extends Error {
  override readonly name: string = 'KinuError';
  declare readonly execution?: { readonly exitCode: number };

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions & { execution?: { readonly exitCode: number } },
  ) {
    super(message, options);

    if (options?.execution !== undefined) this.execution = options.execution;
  }
}

/**
 * Refusal payload on a tool result, reason first. A type alias, not an interface: only aliases get
 * the implicit index signature needed to be returned as `JsonValue`.
 */
export type Refusal = {
  readonly reason: ErrorCode;
  readonly error: string;
  /** The exit the substrate already reported — a 127 must not read as any other `unavailable`. */
  readonly execution?: { readonly exitCode: number };
};

export function refusalOf(error: KinuError): Refusal {
  const refusal = { reason: error.code, error: renderCauseChain(error) };

  return error.execution === undefined ? refusal : { ...refusal, execution: error.execution };
}

/** The whole `cause` chain on one line, outermost first; cycles terminate. */
export function renderCauseChain(error: Error): string {
  const parts: string[] = [];
  const seen = new Set<Error>();

  // A wrapper may embed its cause's words; skip a link the chain already ends with.
  const push = (text: string): void => {
    if (text.length === 0) return;
    const tail = parts.at(-1);

    if (tail !== undefined && tail.endsWith(text)) return;
    parts.push(text);
  };

  let link: Error | null = error;

  while (link !== null && !seen.has(link)) {
    seen.add(link);
    push(link.message);
    // Annotated: without it `link` and `cause` are mutually recursive and resolve to `any` (TS7022).
    const cause: unknown = link.cause;

    if (cause instanceof Error) {
      link = cause;
      continue;
    }

    const spoken = scalarText({ value: cause });

    if (spoken !== null) push(spoken);
    link = null;
  }

  return parts.join(': ');
}

/**
 * {@link renderCauseChain} for an unnarrowed value (`catch` binding, rejection, RPC payload).
 * Prefer `renderCauseChain(toKinuError(...))` where a `doing` frame and fallback class exist.
 */
export function renderThrownChain(input: { cause: unknown }): string {
  return input.cause instanceof Error ? renderCauseChain(input.cause) : String(input.cause);
}

/** The name, not `code`, is the stable discriminator. */
const CODE_BY_ERROR_NAME = new Map<string, ErrorCode>([
  ['AbortError', 'cancelled'],
  ['TimeoutError', 'timeout'],
  ['CapabilityDeniedError', 'denied'],
]);

/** Refused by another object, a shape was our bad input. */
const CODE_BY_REMOTE_NAME = new Map<string, ErrorCode>([...CODE_BY_ERROR_NAME, ['ValiError', 'bad_input']]);

/** A DO's RPC rethrows a custom error as a `remote` Error named in its message. */
// As trustworthy as the thrower: a slate facet or codemode guest can forge the name. A label, never an authorization.
function codeByName(caught: Error): ErrorCode | undefined {
  const remote = 'remote' in caught && caught.remote === true && caught.name === 'Error';
  const named = remote ? /^([A-Z][A-Za-z]*Error): /u.exec(caught.message)?.[1] : undefined;

  return named === undefined ? CODE_BY_ERROR_NAME.get(caught.name) : CODE_BY_REMOTE_NAME.get(named);
}

const CODE_BY_ERRNO = new Map<string, ErrorCode>([
  ['ETIMEDOUT', 'timeout'],
  ['ABORT_ERR', 'cancelled'],
  ['EACCES', 'denied'],
  ['EPERM', 'denied'],
  ['ENOMEM', 'oom'],
  ['ENOTSUP', 'unsupported'],
  ['ECONNREFUSED', 'unavailable'],
  ['ECONNRESET', 'io'],
  ['EHOSTUNREACH', 'unavailable'],
  ['ENOENT', 'missing'],
  ['ESRCH', 'missing'],
]);

/**
 * Memory-wall wordings from platform-catalog.ts: do.isolate.oom_catchable, do.isolate.oom_reported,
 * worker.memory_kill_is_burst_sensitive, worker.isolate.memory. Substring match: the wording
 * arrives wrapped. `Worker exceeded resource limits` is excluded: worker.isolate.memory and
 * do.cpu_ms_per_invocation share it. do.isolate.reset_silent has no wording.
 */
const OOM_SIGNATURES: readonly RegExp[] = [
  /exceeded (?:its )?memory limit/iu,
  /memory limit would be exceeded/iu,
  /exceededMemory/iu,
];

/**
 * Class of a caught value, or null when nothing pinned recognises it; callers supply the fallback.
 * Reads the cause chain outermost first; the first recognised class wins.
 */
export function classifyErrorCode(input: { cause: unknown }): ErrorCode | null {
  const seen = new Set<Error>();
  let caught: unknown = input.cause;

  for (;;) {
    if (caught instanceof KinuError) return caught.code;

    if (classify({ cause: caught }) === 'malformed-input') return 'bad_input';

    if (!(caught instanceof Error) || seen.has(caught)) break;
    seen.add(caught);

    const byName = codeByName(caught);

    if (byName !== undefined) return byName;

    const errno = errnoCode(caught);
    const byErrno = errno === null ? undefined : CODE_BY_ERRNO.get(errno);

    if (byErrno !== undefined) return byErrno;

    caught = caught.cause;
  }

  if (!(input.cause instanceof Error)) return null;
  const chain = renderCauseChain(input.cause);

  return OOM_SIGNATURES.some((signature) => signature.test(chain)) ? 'oom' : null;
}

/**
 * Wrap a caught value as a classified error whose message is `doing` and whose `cause` is the
 * caught value. An already-classified cause keeps its code.
 */
export function toKinuError(
  input: { doing: string; cause: unknown; otherwise: ErrorCode },
): KinuError {
  const code = classifyErrorCode({ cause: input.cause }) ?? input.otherwise;

  return new KinuError(code, input.doing, { cause: input.cause });
}
