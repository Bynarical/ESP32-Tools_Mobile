/**
 * Bundle the web front end into web/dist.
 *
 * esbuild rather than a framework toolchain for two reasons: it is one
 * dependency, and the output is a single file small enough to be worth
 * considering as something the board itself could serve one day.
 *
 *   node web/build.mjs           bundle once
 *   node web/build.mjs --watch   rebuild on change
 *   node web/build.mjs --serve   rebuild and serve on port 8123
 *
 * --serve binds every interface, not just loopback, because the two addresses
 * it hands you do different jobs and you need both:
 *
 *   http://localhost:8123      a secure context, so Web Bluetooth works, and
 *                              plain http, so the board is reachable. The only
 *                              address where both transports work at once.
 *   http://<this-pc>:8123      what a phone can open. Plain http on the LAN,
 *                              so Wi-Fi upload works - including on an iPhone,
 *                              which has no Web Bluetooth in any browser.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const outdir = join(here, 'dist');

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

/** Every IPv4 address a phone on the same network could reach this on. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// The static half: the page, the installable-app files, and the icon they
// both point at. Copied rather than bundled - esbuild has no business
// rewriting a manifest.
await Promise.all([
  cp(join(here, 'index.html'), join(outdir, 'index.html')),
  cp(join(here, 'manifest.webmanifest'), join(outdir, 'manifest.webmanifest')),
  cp(join(here, 'sw.js'), join(outdir, 'sw.js')),
  cp(join(root, 'assets', 'icon.png'), join(outdir, 'icon.png')),
  cp(join(root, 'assets', 'favicon.png'), join(outdir, 'favicon.png')),
]);

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
    const { port } = await ctx.serve({
      servedir: outdir,
      port: 8123,
      // Loopback only would hide it from every phone on the network, which is
      // the main reason to run this at all.
      host: '0.0.0.0',
    });
    const lan = lanAddresses();
    console.log('\n  ESP32 OTA web\n');
    console.log(`    this PC        http://localhost:${port}`);
    console.log('                   Bluetooth and Wi-Fi both work here.\n');
    for (const address of lan) {
      console.log(`    a phone        http://${address}:${port}`);
    }
    if (lan.length > 0) {
      console.log('                   Wi-Fi only - plain http is not a secure');
      console.log('                   context, so the browser withholds Bluetooth.');
      console.log('                   This is the address an iPhone can use.\n');
    }
  }
} else {
  await esbuild.build(options);
  console.log(`bundled -> ${outdir}`);
}
