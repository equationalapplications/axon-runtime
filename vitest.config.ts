import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Opt-in suites: *.live.test.ts calls a real model endpoint (AXON_LIVE=1);
    // *.ssh.test.ts needs key-based `ssh localhost` (AXON_SSH=1).
    exclude: [
      ...(process.env.AXON_LIVE === '1' ? [] : ['tests/**/*.live.test.ts']),
      ...(process.env.AXON_SSH === '1' ? [] : ['tests/**/*.ssh.test.ts']),
    ],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
