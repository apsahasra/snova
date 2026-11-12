// All configuration is read from environment variables in one place,
// so nothing else in the code base touches process.env directly.

// Node 20.12+ can load a .env file without a dependency. It is optional.
try {
  process.loadEnvFile();
} catch {
  // no .env file - fine, use the real environment
}

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  isProduction: env.NODE_ENV === 'production',
  databaseUrl: env.DATABASE_URL || '',

  // Money rules. All amounts are integer paise (1 rupee = 100 paise).
  maxAmountPerTransaction: 1_000_000_000, // Rs 1,00,00,000.00
  maxAccountBalance: 9_000_000_000_000_000, // stays inside Number.MAX_SAFE_INTEGER

  sessionHours: 8,
};
