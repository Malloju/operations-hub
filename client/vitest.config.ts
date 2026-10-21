import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], test: { environment: 'jsdom', include: ['tests/**/*.test.tsx'], testTimeout: 30000, hookTimeout: 30000 } });
