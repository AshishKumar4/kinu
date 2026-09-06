import { DetailedProfileError } from "../profile-runtime/index.js";
export type FilesystemErrorCode = "not-found" | "exists" | "not-a-directory" | "is-a-directory" | "path.invalid" | "too-large" | "content-mismatch";
export declare const FILESYSTEM_ERROR_CODES: readonly FilesystemErrorCode[];
export declare class FilesystemError extends DetailedProfileError<FilesystemErrorCode> {
    readonly path: string;
    constructor(code: FilesystemErrorCode, path: string, message: string);
}
