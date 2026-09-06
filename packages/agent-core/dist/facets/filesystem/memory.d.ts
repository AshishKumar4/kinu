import { FilesystemBackend, type FilesystemPage, type FilesystemReadRange, type FilesystemStat, type FilesystemWriteMode } from "./facet.js";
export declare class MemoryFilesystemBackend extends FilesystemBackend {
    #private;
    constructor(maxFileBytes?: number);
    read(path: string, range?: FilesystemReadRange): Uint8Array;
    stat(path: string): FilesystemStat;
    list(path: string, cursor?: string, limit?: number): FilesystemPage;
    write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void;
    remove(path: string): void;
    move(source: string, destination: string): void;
    mkdir(path: string, recursive?: boolean): void;
    private mutablePath;
    private node;
    private directory;
    private toStat;
    private tick;
}
