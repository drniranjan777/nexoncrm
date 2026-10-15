try { process.loadEnvFile('.env'); } catch { /* optional */ }

import { execSync } from 'node:child_process';
import { testDbConfigured } from './db.js';

export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!testDbConfigured() || !url) {
    console.warn('[test] TEST_DATABASE_URL not configured: database integration tests will be skipped.');
    return;
  }
  // Refuse to wipe anything that does not look like a dedicated test database.
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error(`Refusing to reset "${dbName}": TEST_DATABASE_URL must point at a database whose name contains "test".`);
  // Apply pending migrations (non-destructive). Tests create uniquely named tenants/users on every run, so the
  // database does not need to be wiped between runs.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
