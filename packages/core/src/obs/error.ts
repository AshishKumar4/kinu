/**
 * Failure classification carried as a field, so readers need not match prose. `obs/` imports
 * nothing outside `obs/`; OOM signatures below are pinned to platform-catalog.ts by a test.
 */

import { Data, Inspectable } from 'effect';
import { z } from 'zod';
import * as v from 'valibot';
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

/**
 * A classified failure chaining through native `cause`. The name carries the class: DO RPC keeps only
 * `name: message` (compat 2025-12-01; measured 2026-09-26, docs/OBSERVABILITY.md).
 */
export class KinuError extends Data.TaggedError('KinuError')<{
  readonly code: ErrorCode;
  readonly message: string;
  readonly execution?: { readonly exitCode: number };
}> {
  constructor(
    code: ErrorCode,
    message: string,
    options?: ErrorOptions & { execution?: { readonly exitCode: number } },
  ) {
    super(options?.execution === undefined ? { code, message } : { code, message, execution: options.execution });
    this.name = `KinuError[${code}]`;

    if (options !== undefined && 'cause' in options) {
      Object.defineProperty(this, 'cause', { value: options.cause, writable: true, configurable: true });
    }
  }

  override toJSON() {
    return { code: this.code, name: this.name, ...Object.fromEntries(Object.entries(this).filter(([key]) => key !== '_tag')) };
  }

  override [Inspectable.NodeInspectSymbol](): this {
    return this;
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

/** {@link renderCauseChain} for an unnarrowed value; for diagnostics, never a response body. */
export function renderThrownChain(input: { cause: unknown }): string {
  return input.cause instanceof Error ? renderCauseChain(input.cause) : String(input.cause);
}

/** The name, not `code`, is the stable discriminator. */
const CODE_BY_ERROR_NAME = new Map<string, ErrorCode>([
  ['AbortError', 'cancelled'],
  ['TimeoutError', 'timeout'],
  ['CapabilityDeniedError', 'denied'],
  // The SDK refusing a model's tool call against its schema.
  ['AI_InvalidToolInputError', 'bad_input'],
]);

/** Refused by another object, a shape was our bad input. */
const CODE_BY_REMOTE_NAME = new Map<string, ErrorCode>([...CODE_BY_ERROR_NAME, ['ValiError', 'bad_input'], ['ZodError', 'bad_input']]);

/** RPC preserves an error's name and own fields, not its subclass (compat 2026-09-28). */
// As trustworthy as the thrower: a slate facet or codemode guest can forge the name. A label, never an authorization.
function codeByName(caught: Error): ErrorCode | undefined {
  const remote = 'remote' in caught && caught.remote === true;
  const refusal = remote ? remoteRefusal(caught) : null;

  return refusal?.code ?? (remote ? CODE_BY_REMOTE_NAME : CODE_BY_ERROR_NAME).get(caught.name);
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

export const OVERLOADED_SIGNATURE = /Durable Object is overloaded/iu;

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

  if (OOM_SIGNATURES.some((signature) => signature.test(chain))) return 'oom';

  return OVERLOADED_SIGNATURE.test(chain) ? 'unavailable' : null;
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

/** Native RPC preserves these own fields; the receiving Error need not be a KinuError instance. */
function remoteRefusal(error: Error): { code: ErrorCode; message: string } | null {
  if (!('_tag' in error) || error._tag !== 'KinuError' || !('code' in error)) return null;
  const known = v.safeParse(v.picklist(ERROR_CODES), error.code);

  return known.success ? { code: known.output, message: error.message } : null;
}

function authoredMessage(link: Error): string | null {
  if (link instanceof KinuError) return link.message;
  const remote = 'remote' in link && link.remote === true ? remoteRefusal(link) : null;

  return remote === null ? null : remote.message;
}

/** A caught `KinuError`, here or across RPC, with its class and message; anything else ours, classified as `doing`. */
export function authoredRefusal(input: { doing: string; cause: unknown }): KinuError {
  const { cause } = input;

  if (cause instanceof KinuError) return cause;
  const remote = cause instanceof Error && 'remote' in cause && cause.remote === true ? remoteRefusal(cause) : null;

  return remote === null ? toKinuError({ doing: input.doing, cause, otherwise: 'io' }) : new KinuError(remote.code, remote.message, { cause });
}

function unauthoredText(link: Error): string {
  return authoredMessage(link) === null ? link.message : '';
}

/** `error.message`, or null when it quotes a cause no `KinuError` authored. */
export function publicMessage(error: KinuError): string | null {
  const seen = new Set<unknown>();

  for (let link: unknown = error.cause; link !== undefined && link !== null && !seen.has(link); link = link instanceof Error ? link.cause : null) {
    seen.add(link);
    const text = link instanceof Error ? unauthoredText(link) : scalarText({ value: link }) ?? '';

    if (text.length > 0 && error.message.includes(text)) return null;
  }

  return error.message.length > 0 ? error.message : null;
}

/** The zod refusal under the SDK's wrappers. */
function zodErrorIn(error: Error): z.ZodError | undefined {
  const seen = new Set<Error>();

  for (let link: unknown = error; link instanceof Error && !seen.has(link); link = link.cause) {
    if (link instanceof z.ZodError) return link;
    seen.add(link);
  }

  return undefined;
}

/** `call` refused as `bad_input` in zod's rendering; not its cause, whose message is the issues as JSON. */
export function refusedInput(call: string, error: Error): KinuError {
  const refusal = zodErrorIn(error);

  if (refusal === undefined) return new KinuError('bad_input', call, { cause: error });
  const problems = z.prettifyError(refusal).split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ');

  return new KinuError('bad_input', `${call}: ${problems}`);
}
