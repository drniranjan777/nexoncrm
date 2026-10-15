const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  appUrl: env.APP_URL ?? 'http://localhost:5174',
  feedbackPublicUrl: env.FEEDBACK_PUBLIC_URL ?? env.APP_URL ?? 'http://localhost:5174',
  cookieSecure: env.COOKIE_SECURE === 'true',
  sessionTtlDays: 14,
  redisUrl: env.REDIS_URL || undefined,
  smtp: {
    host: env.SMTP_HOST || undefined,
    port: Number(env.SMTP_PORT ?? 587),
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.MAIL_FROM ?? 'Nexonweb <no-reply@nexonweb.com>',
  },
  storage: {
    driver: (env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localDir: env.STORAGE_DIR ?? 'storage',
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION ?? 'auto',
      bucket: env.S3_BUCKET ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    },
  },
  ai: {
    provider: (env.AI_PROVIDER ?? 'heuristic') as 'heuristic' | 'anthropic',
    anthropicKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  },
  isTest: env.NODE_ENV === 'test' || env.VITEST === 'true',
};
