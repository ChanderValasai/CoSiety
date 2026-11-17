import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { initAllSchemas } from './server/db.ts';
import { seedInitialData } from './server/seed.ts';
import { apiRouter } from './server/apiRouter.ts';

async function startServer() {
  initAllSchemas();
  seedInitialData();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'cosiety-portal' });
  });

  app.use('/api/v1', apiRouter);

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Cosiety server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Cosiety server:', err);
  process.exit(1);
});
