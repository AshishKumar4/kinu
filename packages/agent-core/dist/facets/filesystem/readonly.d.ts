import { FilesystemReaderBackend, type FilesystemPage, type FilesystemReadRange, type FilesystemStat } from "./facet.js";
export declare class ReadonlyFilesystemBackend extends FilesystemReaderBackend {
    private readonly filesystem;
    constructor(filesystem: FilesystemReaderBackend);
    read(path: string, range?: FilesystemReadRange): Uint8Array;
    stat(path: string): FilesystemStat;
    list(path: string, cursor?: string, limit?: number): FilesystemPage;
}
