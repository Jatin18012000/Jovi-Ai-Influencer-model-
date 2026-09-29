import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Tests use in-memory SQLite and mocked providers; never real paid APIs.
    env: {
      JOVI_LOG_LEVEL: 'silent',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
    },
  },
});
