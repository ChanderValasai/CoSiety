import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createApiApp } from './server/app.ts';

async function startServer() {
  const app = createApiApp();
  const httpServer = http.createServer(app);

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const enableHmr = process.env.ENABLE_HMR === 'true' && process.env.DISABLE_HMR !== 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: enableHmr ? { server: httpServer } : false,
        ws: { server: httpServer },
        watch: process.env.DISABLE_HMR === 'true' ? null : undefined,
      },
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
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`CoSiety server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Cosiety server:', err);
  process.exit(1);
});
