import { createApp } from './app.js';
import { config } from './lib/config.js';
import { prisma } from './lib/db.js';
import { startJobs, stopJobs } from './lib/queue.js';

const app = createApp();

const server = app.listen(config.port, async () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
  await startJobs();
});

async function shutdown() {
  server.close();
  await stopJobs();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
