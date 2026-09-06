import { type ScopeRef, type SubjectRef } from "../identity/index.js";
import type { JsonValue } from "../core/index.js";
export type { ScopeRef, SubjectRef } from "../identity/index.js";
export declare function scopeKey(scope: ScopeRef): string;
export declare function subjectKey(subject: SubjectRef): string;
export declare function encodeAuthorityScope(scope: ScopeRef): JsonValue;
export declare function decodeAuthorityScope(value: JsonValue): ScopeRef;
export declare function encodeAuthoritySubject(subject: SubjectRef): JsonValue;
export declare function decodeAuthoritySubject(value: JsonValue): SubjectRef;
