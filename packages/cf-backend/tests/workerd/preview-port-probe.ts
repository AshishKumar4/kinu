import { DurableObject } from 'cloudflare:workers';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';

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
        transactions: { storage: this.ctx.storage },
      });

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

  /** A user-invoked program that outlives the 30 s wall-clock lifetime
   *  Nimbus once imposed: its exit code is the program's own. */
  async outlast(seconds: number): Promise<ShellProbeReport> {
    const workspace = await this.workspace();
    const result = await workspace.shell.execute(`sleep ${String(seconds)} && echo outlasted`, { cwd: '/home/user' });

    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async curlLoopback(port: number): Promise<ShellProbeReport> {
    const workspace = await this.workspace();

    const result = await workspace.shell.execute(`curl -sS http://127.0.0.1:${port}/`, {
      cwd: '/home/user',
    });

    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

}
