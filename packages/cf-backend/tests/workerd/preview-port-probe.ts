/**
 * Port-preview probe: the staged workspace defects, executed for real in workerd.
 *
 * Two observations from the acceptance lane on staging b04c01d31, both measured
 * here against the REAL library workspace over this object's own SQLite:
 *
 *   1. `node -e` and `node <file>` answer "Code generation from strings
 *      disallowed for this context" — the `node` command shim compiles its
 *      source with `new Function`, which workerd forbids. `bun test` runs the
 *      same shim happily, which is why the suite stayed green.
 *
 *   2. `curl http://127.0.0.1:<port>/` answers a Cloudflare `error code: 1003`
 *      page. The library registry loads `curl` with no kernel, so the virtual
 *      port check is skipped and the loopback request falls through to the
 *      platform `fetch`, which reaches the edge instead of the virtual server.
 *
 * `NimbusWorkspace.create` directly, not the Kinu bundle boot: same reason as
 * the files-eio probe — the bundle's runtime toolkit imports a CJS graph this
 * pool cannot shim, and the read under test never reaches it.
 */
import { DurableObject } from 'cloudflare:workers';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { wireWorkspaceLoopback } from '@kinu.run/core';

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
