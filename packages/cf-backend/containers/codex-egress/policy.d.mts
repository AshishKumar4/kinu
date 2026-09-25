export declare const ALLOWED_ROUTES: readonly string[];

export declare const TARGET_HEADER: string;

export declare const HOP_BY_HOP: ReadonlySet<string>;

export declare function refusal(method: string | undefined, target: string | undefined): { readonly status: number; readonly text: string } | null;

export declare function forwardedHeaders(incoming: Readonly<Record<string, string | readonly string[] | undefined>>): Headers;
