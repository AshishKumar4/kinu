import { DurableObject } from 'cloudflare:workers';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { wireWorkspaceLoopback } from '../../../core/src/vfs/workspace-runtimes';

export interface ShellProbeReport {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}


export class PreviewPortProbeDO extends DurableObject<Cloudflare.Env> {
  private _workspace: Promise<NimbusWorkspace> | undefined;

  private workspace(): Promise<NimbusWorkspace> {
    this._workspace ??= (async () => {
      const workspace = await NimbusWorkspace.create({
        sql: this.ctx.storage.sql,
        transactions: this.ctx,
      });
      // The same call the hosted boot makes after its runtime provisioning —
      // the loopback wiring under test. The full provisioning is skipped for
      // the reason the files-eio probe documents: its toolkit imports a CJS
      // graph this pool cannot load, and the commands under test never reach it.
      wireWorkspaceLoopback(workspace);
      return workspace;
    })();
    return this._workspace;
  }

  async nodeEval(): Promise<ShellProbeReport> {
    const workspace = await this.workspace();
    // A program that exits at once: the shim compiles before it runs, so a
    // codegen block fails here without hanging the shell on a listener.
    const result = await workspace.shell.execute(`node -e 'console.log("hi")'`, {
      cwd: '/home/user',
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async nodeFile(): Promise<ShellProbeReport> {
    const workspace = await this.workspace();
    await workspace.fs.writeFile('/home/user/probe-8789.js', 'console.log("Kinu live preview");\n');
    const result = await workspace.shell.execute('node probe-8789.js', { cwd: '/home/user' });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  /** A virtual server the host registers with no compilation: the port the
   *  loopback check must answer with these bytes. */
  async serveLoopback(port: number, body: string): Promise<{ registered: boolean }> {
    const workspace = await this.workspace();
    workspace.kernel.portRegistry.set(port, (_req, res) => {
      res.statusCode = 200;
      res.headers = { 'content-type': 'text/plain' };
      res.body = body;
    });
    return { registered: workspace.kernel.portRegistry.has(port) };
  }

  async unserveLoopback(port: number): Promise<{ removed: boolean }> {
    const workspace = await this.workspace();
    workspace.kernel.portRegistry.delete(port);
    return { removed: !workspace.kernel.portRegistry.has(port) };
  }

  async curlLoopback(port: number): Promise<ShellProbeReport> {
    const workspace = await this.workspace();
    const result = await workspace.shell.execute(`curl -sS http://127.0.0.1:${port}/`, {
      cwd: '/home/user',
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

}
