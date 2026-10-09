import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const SCRIPT = fileURLToPath(new URL('../../scripts/prerender-landing.ts', import.meta.url));

/** Once the client build has written `landing.html`, fills its root with the page's markup (the script says why). */
export function landingPrerender(): Plugin {
  return {
    name: 'kinu:landing-prerender',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    async writeBundle(options, bundle) {
      const dir = options.dir;

      if (dir === undefined || !('landing.html' in bundle)) return;

      const code = await new Promise<number | null>((exited, failed) => {
        const child = spawn('bun', [SCRIPT, dir], { stdio: 'inherit' });
        child.once('error', failed);
        child.once('exit', exited);
      });

      if (code !== 0) this.error(`prerendering the landing exited with ${String(code)}`);
    },
  };
}
