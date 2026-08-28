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
          BENCH_SELECTED_ARMS: 'bounded-layers,merkle-pack',
        },
      },
    }),
  ],
  test: { include: ['tests/workerd/**/*.test.ts'] },
});
