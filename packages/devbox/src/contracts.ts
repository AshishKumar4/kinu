import type { DevboxGateway, GatewayProps } from './gateway';

/** No signal: the platform acts on one with a kill nobody can await (`endProcess`). */
export type DevboxExecOptions = Pick<ContainerExecOptions, 'cwd' | 'env'>;

export interface GatewayBindings {
  readonly DevboxGateway?: (options: { readonly props: GatewayProps }) => Pick<Service<DevboxGateway>, keyof Fetcher>;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ReadOptions {
  readonly encoding?: 'utf-8' | 'base64';
}

export interface FileResult {
  readonly content: string;
  readonly encoding: 'utf-8' | 'base64';
}

export interface ListFilesOptions {
  readonly recursive?: boolean;
}

export interface FileMetadata {
  readonly type: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly uid: number;
  readonly gid: number;
  readonly atimeMs: number;
  readonly ctimeMs: number;
}

export interface ListedFile extends FileMetadata {
  readonly name: string;
  readonly path: string;
}

