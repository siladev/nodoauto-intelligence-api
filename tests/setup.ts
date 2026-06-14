// Entorno dummy para los tests: loadEnv() (que corre al importar logger/clientes)
// exige los secretos presentes. Valores ficticios — los tests NO tocan red real.
process.env.SUPABASE_URL ??= 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key'
process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key'
process.env.SERVICE_SHARED_TOKEN ??= 'test-token-1234567890'
process.env.NODE_ENV ??= 'test'
process.env.LOG_LEVEL ??= 'silent'
