import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  root: 'apps/client', base: './', plugins: [react()],
  resolve: { alias: { '@dreamclaw': fileURLToPath(new URL('./apps/client/src/dreamclaw', import.meta.url)) } },
  define: { __E3_VERSION__: JSON.stringify(pkg.version), __E3_BUILD__: JSON.stringify(pkg.edition3.buildVersion) },
  server: { host: '127.0.0.1', port: 4384, strictPort: true, proxy: { '/api': process.env.E3_DEV_API_ORIGIN ?? 'http://127.0.0.1:4383' } },
  build: {
    outDir: '../../dist/client', emptyOutDir: true, sourcemap: false, manifest: true,
    rolldownOptions: {
      output: {
        // Keep the existing transcript renderer in its own deferred dependency.
        // Shared React dependencies form their own complete group first, so the
        // transcript library does not become an entry dependency through React.
        codeSplitting: { groups: [
          { name: 'react-runtime', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 20 },
          { name: 'virtual-transcript', test: /node_modules[\\/]react-virtuoso[\\/]/, priority: 10 },
        ] },
      },
    },
  },
});
