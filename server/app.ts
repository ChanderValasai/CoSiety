import express from 'express';
import { initAllSchemas } from './db.ts';
import { seedInitialData } from './seed.ts';
import { apiRouter } from './apiRouter.ts';

let initialized = false;

export function ensureDbInitialized(): void {
  if (initialized) return;
  initAllSchemas();
  seedInitialData();
  initialized = true;
}

export function createApiApp(): express.Express {
  ensureDbInitialized();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get(['/api/health', '/health'], (_req, res) => {
    res.json({ ok: true, service: 'cosiety-portal' });
  });

  app.get(['/api/v1/health', '/v1/health'], (_req, res) => {
    res.json({ ok: true, service: 'cosiety-portal', version: 'v1.1' });
  });

  app.use(['/api/v1', '/v1'], apiRouter);
  return app;
}
