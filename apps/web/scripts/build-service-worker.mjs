// Builds the service worker (apps/web/src/sw/worker.ts) into one classic
// script, dist/apps/web-sw/sw.js; the Angular build copies it to the root of
// the app (see project.json). A separate build because the Angular builder
// has no entry point for service workers.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

await build({
  entryPoints: [join(root, 'apps/web/src/sw/worker.ts')],
  outfile: join(root, 'dist/apps/web-sw/sw.js'),
  tsconfig: join(root, 'apps/web/tsconfig.sw.json'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  minify: process.argv.includes('--minify'),
  legalComments: 'none',
  logLevel: 'warning',
});
