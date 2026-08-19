process.env.NODE_ENV = 'test';
// Throwaway values that satisfy src/config/env.ts validation so suites can load
// modules that import `env` (tests mock prisma/network — nothing real is hit).
// JWT_ACCESS_SECRET is the name env.ts actually validates (the old JWT_SECRET
// key it once set here is read by nothing and made every suite die at import
// time with process.exit(1)).
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long!!';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-min-32-chars!!';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/sawa_test';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq-key';
