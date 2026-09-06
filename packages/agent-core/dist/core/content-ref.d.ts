import { Digest } from "./digest.js";
import { TextId } from "./id.js";
export declare class ContentRef extends TextId {
    readonly digest: Digest;
    constructor(value: string);
    static fromDigest(digest: Digest): ContentRef;
}
/**
 * One ContentRef a durable record names, under the exact field path the record registry
 * declares for its kind. A record projects itself onto these and never onto owner keys: the
 * key is the custody plane's to derive, so one record shape cannot name content under two
 * different keys. It lives beside ContentRef rather than in the content plane because a
 * record that names content must not take a runtime dependency on the plane that retains it.
 */
export interface ContentRetentionField {
    readonly field: string;
    readonly ref: ContentRef;
}
/**
 * The projection helper every record-adjacent retention function is written through. An
 * absent optional ContentRef contributes no field rather than an empty one, so a record that
 * names nothing yields no owner edge at all.
 */
export declare function contentRetentionFields(fields: readonly (readonly [field: string, ref: ContentRef | undefined])[]): readonly ContentRetentionField[];
