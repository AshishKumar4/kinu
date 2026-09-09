import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './bench/worker.ts',
      miniflare: {
        compatibilityDate: '2025-12-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          BENCH_TOKEN: 'test-token',
          // AN ARM THIS RUN DOES NOT DEPLOY, deliberately: the guard in
          // `tests/workerd/bench-selected-arm.test.ts` is only live when the
          // selected set does not name the strategy a request asks for.
          BENCH_SELECTED_ARMS: 'none-of-them',
        },
      },
    }),
  ],
  test: { include: ['tests/workerd/**/*.test.ts'] },
});
