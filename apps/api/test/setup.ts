try { process.loadEnvFile(".env"); } catch { /* optional */ }
// Integration tests run against TEST_DATABASE_URL, never the development database.
// The global setup (test/global-setup.ts) syncs that database schema before the run.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.NODE_ENV = 'test';
process.env.STORAGE_DIR = 'storage-test';
process.env.AI_PROVIDER = 'heuristic';
process.env.SMTP_HOST = '';
process.env.REDIS_URL = '';
