import { FilesystemBackend, type FilesystemPage, type FilesystemReadRange, type FilesystemStat, type FilesystemWriteMode } from "./facet.js";
export interface FilesystemObservation {
    readonly operation: "read" | "stat" | "list" | "write" | "remove" | "move" | "mkdir";
    readonly paths: readonly string[];
}
export declare abstract class FilesystemObservationBackend {
    abstract record(observation: FilesystemObservation): void;
}
export declare class ObservedFilesystemBackend extends FilesystemBackend {
    private readonly backend;
    private readonly observations;
    constructor(backend: FilesystemBackend, observations: FilesystemObservationBackend);
    read(path: string, range?: FilesystemReadRange): Uint8Array;
    stat(path: string): FilesystemStat;
    list(path: string, cursor?: string, limit?: number): FilesystemPage;
    write(path: string, content: Uint8Array, mode: FilesystemWriteMode): void;
    remove(path: string): void;
    move(source: string, destination: string): void;
    mkdir(path: string, recursive?: boolean): void;
    private record;
}
