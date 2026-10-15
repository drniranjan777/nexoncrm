import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './lib/config.js';
import { loadUser } from './middleware/auth.js';
import { requireTenant } from './middleware/tenant.js';
import { errorHandler } from './middleware/validate.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './modules/auth.js';
import { publicRouter } from './modules/public.js';
import { platformRouter } from './modules/platform.js';
import { tenantRouter } from './modules/index.js';

// Prisma returns BigInt for some counters; serialise them as numbers in JSON responses.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: [config.appUrl, config.feedbackPublicUrl], credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // CSRF defence for cookie-authenticated requests: state-changing requests must carry a
  // custom header, which browsers will not send cross-site without a CORS preflight.
  app.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path.startsWith('/api/v1/public/')) return next();
    if (req.headers.authorization?.startsWith('Bearer ')) return next();
    if (req.header('x-requested-with') !== 'nexonweb') return next(new HttpError(403, 'Missing X-Requested-With header'));
    next();
  });

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use(loadUser);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/public', publicRouter);
  app.use('/api/v1/platform', platformRouter);
  app.use('/api/v1', requireTenant, tenantRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
