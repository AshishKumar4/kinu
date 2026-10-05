import type { DevboxOutbound, OutboundProps } from './gateway';
import type { DevboxStoreGateway, StoreGatewayProps } from './store-gateway';

export type DevboxExecOptions = Pick<ContainerExecOptions, 'cwd' | 'env' | 'signal'>;

export interface GatewayBindings {
  readonly DevboxStoreGateway?: (options: { readonly props: StoreGatewayProps }) => Pick<Service<DevboxStoreGateway>, keyof Fetcher>;
  readonly DevboxOutbound?: (options: { readonly props: OutboundProps }) => Pick<Service<DevboxOutbound>, keyof Fetcher>;
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

export interface ListedFile {
  readonly name: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly type: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

