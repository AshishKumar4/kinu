import { defineConfig } from 'armada';

/** The tasks Kinu runs on armada, each exported from a file under armada/. */
export default defineConfig({ project: 'kinu', tasks: ['armada'] });
