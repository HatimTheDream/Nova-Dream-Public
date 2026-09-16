import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  root: 'apps/client', plugins: [react()],
  resolve: { alias: { '@dreamclaw': fileURLToPath(new URL('./apps/client/src/dreamclaw', import.meta.url)) } },
  define: { __E3_VERSION__: JSON.stringify(pkg.version), __E3_BUILD__: JSON.stringify(pkg.edition3.buildVersion) },
  server: { host: '127.0.0.1', port: 4384, strictPort: true, proxy: { '/api': process.env.E3_DEV_API_ORIGIN ?? 'http://127.0.0.1:4383' } },
  build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: false, manifest: true },
});
