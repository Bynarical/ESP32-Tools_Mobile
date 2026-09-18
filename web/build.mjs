/**
 * Bundle the web front end into web/dist.
 *
 * esbuild rather than a framework toolchain for two reasons: it is one
 * dependency, and the output is a single file small enough to be worth
 * considering as something the board itself could serve one day.
 *
 *   node web/build.mjs           bundle once
 *   node web/build.mjs --watch   rebuild on change
 *   node web/build.mjs --serve   rebuild and serve on http://localhost:8123
 *
 * --serve is the mode that matters during development: localhost is a secure
 * context, so Web Bluetooth is offered, and it is plain http, so the board is
 * reachable. It is the only address where both transports work at once.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, 'dist');

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(join(here, 'index.html'), join(outdir, 'index.html'));

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(here, 'src', 'main.ts')],
  outfile: join(outdir, 'app.js'),
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  platform: 'browser',
  sourcemap: true,
  minify: !watch && !serve,
  logLevel: 'info',
};

if (watch || serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (serve) {
    const { host, port } = await ctx.serve({ servedir: outdir, port: 8123 });
    console.log(`\n  ESP32 OTA web  ->  http://localhost:${port}\n`);
    console.log('  localhost is the one address where Bluetooth and Wi-Fi both work:');
    console.log('  a secure context (so Web Bluetooth is offered) served over plain');
    console.log('  http (so the board is reachable).\n');
    void host;
  }
} else {
  await esbuild.build(options);
  console.log(`bundled -> ${outdir}`);
}
