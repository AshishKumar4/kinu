import { FilesystemBackend, type FilesystemPage, type FilesystemReadRange, type FilesystemStat, type FilesystemWriteMode } from "./facet.js";
export interface FilesystemMount {
    readonly path: string;
    readonly backend: FilesystemBackend;
}
export declare class MountFilesystemBackend extends FilesystemBackend {
    #private;
    constructor(mounts: readonly FilesystemMount[]);
    read(path: string, range?: FilesystemReadRange): Uint8Array;
    stat(path: string): FilesystemStat;
    list(path: string, cursor?: string, limit?: number): FilesystemPage;
    write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void;
    remove(path: string): void;
    move(source: string, destination: string): void;
    mkdir(path: string, recursive?: boolean): void;
    private resolve;
    private resolveForMount;
    private externalStat;
    private externalPath;
}
