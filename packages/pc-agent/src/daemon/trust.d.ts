// The roots this process's TLS no longer trusts (trust.js), for the CLI that embeds the daemon.
export declare const DISTRUSTED_ROOTS: readonly { readonly name: string; readonly sha256: string }[];

export declare function trustedRoots(): string[];

export declare function installTrustedRoots(scope?: { fetch: typeof fetch; WebSocket: typeof WebSocket }): void;
