import { defineConfig } from 'vitest/config'

// Servicio Node (Hono), no app web: sin DOM ni React. Los tests son unitarios y
// puros (logica de routing, idempotencia, validacion, guards de seguridad) con
// dependencias inyectadas — NO tocan Supabase ni Anthropic reales.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
