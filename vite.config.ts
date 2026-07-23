import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // jsdom for component tests; pure logic tests run fine under it too.
    environment: 'jsdom',
  },
});
