// The CLI imports this module twice: its BYTES, to install beside the daemon (the default export, a
// text import), and its API, to sign in and refresh on this machine (the named exports).
declare const source: string;

export default source;

/** One sign-in on this machine: the verified identity, the issued client, and its tokens. */
export interface SiwcRecord {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly clientId: string;
  /** Absent when ChatGPT plan usage was not granted, or the session ended. */
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** Epoch milliseconds. */
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
}

/** What a later sign-in to the same account reuses. */
export interface SiwcRegistration {
  readonly clientId: string;
  readonly subject?: string;
  readonly email?: string;
}

export type SiwcSignInResult =
  | { readonly outcome: 'signed-in' | 'plan-disabled'; readonly registered: boolean; readonly record: SiwcRecord }
  | { readonly outcome: 'declined' };

export interface SiwcTokens {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
}

export declare class SiwcError extends Error {
  readonly code: string | null;
  /** The refresh token is spent: clear the tokens and sign in again with the saved client. */
  readonly unusable: boolean;
}

export declare const ISSUER: string;

export declare const RESOURCE: string;

export declare const PLAN_SCOPE: string;

export declare const SCOPES: readonly string[];

export declare const DYNAMIC_AGENT_CLIENT: string;

export declare const AGENT_NAME_HINT: string;

export declare const CALLBACK_PATH: string;

export declare const DEVICE_RECORD_FILE: string;

export declare const UNUSABLE_REFRESH_CODES: readonly string[];

export declare function hostId(home: string): string;

export declare function planEnabled(record: { readonly scopes?: readonly string[] } | null | undefined): boolean;

export declare function expiring(record: { readonly accessToken?: string; readonly expiresAt?: number } | null | undefined, now: number): boolean;

export declare function beginSignIn(opts: {
  readonly home: string;
  readonly registration?: SiwcRegistration | null;
  /** Ask for consent again: re-enabling plan usage after a decline. */
  readonly consent?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly authorizeUrl: string; readonly redirectUri: string; readonly done: Promise<SiwcSignInResult> }>;

export declare function refreshTokens(opts: {
  readonly clientId: string;
  readonly refreshToken: string;
  /** The grant's scopes, kept when the answer names none. */
  readonly scopes?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): Promise<SiwcTokens>;

/** Never rejects: `unconfirmed` says why OpenAI did not confirm the revocation. */
export declare function revokeSession(opts: { readonly clientId: string; readonly refreshToken: string; readonly fetch?: typeof fetch }): Promise<{ readonly unconfirmed: string | null }>;

/** Any record a sign-in saved (the daemon's file, the CLI's config metadata), read for its registration. */
export interface SavedSignIn {
  readonly clientId?: unknown;
  readonly subject?: unknown;
  readonly email?: unknown;
}

export declare function registrationOf(record: SavedSignIn | null | undefined): SiwcRegistration | null;

export declare function deviceRegistration(home: string): SiwcRegistration | null;

export interface DeviceSessionStatus {
  readonly signedIn: boolean;
  readonly email: string | null;
  readonly planEnabled: boolean;
  /** A sign-in whose grant left out plan usage; a signed-out record is not one. */
  readonly planDeclined: boolean;
  readonly pending: boolean;
  readonly lastFailure: string | null;
  readonly firstSignIn: boolean;
}

export interface DeviceSession {
  status(): DeviceSessionStatus;
  signIn(): Promise<{ readonly authorizeUrl: string }>;
  bearer(rejected?: string): Promise<string | null>;
  signOut(): Promise<{ readonly unconfirmed: string | null }>;
  /** Starts nothing new and waits for what is under way: a landing sign-in, the auth call in flight. */
  quiesce(): Promise<void>;
  /** A forced stop: the auth call in flight ends now, unanswered, and writes nothing. */
  abort(): void;
}

export declare function createDeviceSession(opts: {
  readonly home: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Settles when the daemon this one replaced has exited: nothing writes the record before. */
  readonly predecessorExited?: Promise<void> | null;
}): DeviceSession;
