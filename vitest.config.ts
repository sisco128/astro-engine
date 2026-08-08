import { defineConfig } from 'vitest/config';

/**
 * Suites are selected by path rather than by vitest "projects", which need
 * vitest 3. `pnpm test` runs unit + contract; `pnpm test:golden` runs the
 * suite that touches the real ephemeris files.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Ephemeris work is CPU-bound and synchronous; parallel files only
    // multiply memory for no gain.
    fileParallelism: false,
  },
});
