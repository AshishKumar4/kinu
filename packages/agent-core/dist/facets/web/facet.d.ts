import { Contributions, OperationDescriptor } from "../contribution.js";
import type { FacetManifest } from "../manifest.js";
import { DetailedProfileError, InternalProfileFacetRuntime, ProfileOperationContract, type EffectDispatch, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export type WebHeaders = Readonly<Record<string, string>>;
export interface WebUrlPolicy {
    authorize(url: URL): WebTransportAuthorization;
}
export interface WebCallerHeaderPolicy {
    headersFor(url: URL, requested: WebHeaders): WebHeaders;
}
export interface WebCredentialPolicy {
    headersFor(url: URL): WebHeaders;
}
export interface WebRatePolicy {
    consume(origin: string): boolean;
}
export interface WebTransportAuthorization {
    readonly requestedUrl: string;
    readonly resolvedTarget: string;
    readonly token: object;
}
export interface WebTransportLimits {
    readonly maxResponseBytes: number;
}
export interface WebTransportRequest {
    readonly authorization: WebTransportAuthorization;
    readonly method: string;
    readonly headers: WebHeaders;
    readonly body?: Uint8Array | undefined;
}
export interface WebTransportResponse {
    readonly status: number;
    readonly headers: WebHeaders;
    readonly body: Uint8Array;
    readonly redirect?: string;
}
export interface WebTransport {
    /**
     * Issues the authorized outbound request carrying its canonical effect identity. The
     * provider MUST treat `dispatch.idempotencyKey` as the dedup key for the request and
     * MUST be able to answer a reconciliation query addressed by `dispatch.attempt`
     * identity, so a crash-after-send retry neither re-sends nor stays indeterminate
     * (SPEC §7.4).
     */
    send(request: WebTransportRequest, limits: WebTransportLimits, dispatch: EffectDispatch): Promise<WebTransportResponse>;
}
export interface WebRequest extends PublicProfileInput {
    readonly url: string;
    readonly method?: string;
    readonly headers?: WebHeaders;
    readonly body?: Uint8Array;
}
export interface WebSearchInput extends PublicProfileInput {
    readonly query: string;
    readonly limit?: number;
}
export interface WebCachedInput extends PublicProfileInput {
    readonly key: string;
}
export interface WebResponse {
    readonly url: string;
    readonly status: number;
    readonly headers: WebHeaders;
    readonly body: Uint8Array;
}
export interface WebFacetConfig {
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxRedirects: number;
    readonly searchEndpoint: string;
}
export interface WebResponseCache {
    read(key: string): WebResponse | undefined;
}
export declare const WEB_OPERATION_CONTRACTS: Readonly<{
    fetch: ProfileOperationContract<"fetch", WebRequest, WebResponse, "output">;
    search: ProfileOperationContract<"search", WebSearchInput, WebResponse, "output">;
    readCached: ProfileOperationContract<"readCached", WebCachedInput, WebResponse | undefined, "output">;
}>;
export declare const WEB_OPERATIONS: readonly OperationDescriptor[];
export declare const WEB_CONTRIBUTIONS: Contributions;
export declare class WebBackend {
    private readonly config;
    private readonly urls;
    private readonly callerHeaders;
    private readonly credentials;
    private readonly rates;
    private readonly transport;
    private readonly cache;
    constructor(config: WebFacetConfig, urls: WebUrlPolicy, callerHeaders: WebCallerHeaderPolicy, credentials: WebCredentialPolicy, rates: WebRatePolicy, transport: WebTransport, cache: WebResponseCache);
    fetch(request: WebRequest, dispatch: EffectDispatch): Promise<WebResponse>;
    search(query: string, limit: number | undefined, dispatch: EffectDispatch): Promise<WebResponse>;
    readCached(key: string): WebResponse | undefined;
    private safeUrl;
    private authorizeTarget;
}
export declare class WebFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    static readonly operations: readonly OperationDescriptor[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: WebBackend);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    fetch(input: WebRequest): Promise<WebResponse>;
    search(input: WebSearchInput): Promise<WebResponse>;
    readCached(input: WebCachedInput): Promise<WebResponse | undefined>;
}
export type WebPolicyErrorCode = "url.denied" | "credential.denied" | "rate.exceeded" | "size.exceeded" | "redirect.denied" | "search.invalid" | "cache.invalid";
export declare class WebPolicyError extends DetailedProfileError<WebPolicyErrorCode> {
    constructor(detailCode: WebPolicyErrorCode, message: string);
}
export declare class FixedWindowRatePolicy implements WebRatePolicy {
    #private;
    private readonly maximum;
    private readonly windowMilliseconds;
    private readonly now;
    constructor(maximum: number, windowMilliseconds: number, now?: () => number);
    consume(origin: string): boolean;
}
