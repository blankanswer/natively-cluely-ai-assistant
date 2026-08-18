#!/usr/bin/env node
/**
 * Lite CN Electron build.
 *
 * Keeps upstream sources intact while swapping the OpenAI realtime STT module
 * for the pure REST Lite adapter. Premium sources are never added as entry
 * points, and premium-only resolver seams are replaced with Lite stubs, so this
 * build does not require the private premium submodule.
 */
const { build } = require('esbuild');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const electronDir = path.join(rootDir, 'electron');
const outDir = path.join(rootDir, 'dist-electron');
const liteStt = path.join(electronDir, 'audio', 'LiteOpenAICompatibleSTT.ts');
const liteCompanySearchResolver = path.join(electronDir, 'lite', 'resolveCompanySearchProvider.ts');
const upstreamCompanySearchResolver = path.join(electronDir, 'services', 'resolveCompanySearchProvider.ts');

const SKIP_DIR_PARTS = [
  `${path.sep}__tests__${path.sep}`,
  `${path.sep}visionBenchmark${path.sep}`,
];

const SKIP_ENTRY_FILES = new Set([
  upstreamCompanySearchResolver,
]);

function findTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIR_PARTS.some((part) => full.includes(part))) continue;
    if (entry.isDirectory()) out.push(...findTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !SKIP_ENTRY_FILES.has(full)) out.push(full);
  }
  return out;
}

const entryPoints = findTs(electronDir).map((file) => path.relative(rootDir, file));

const liteAliases = {
  name: 'lite-cn-aliases',
  setup(buildApi) {
    buildApi.onResolve({ filter: /OpenAIStreamingSTT$/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      return { path: liteStt };
    });

    // Several otherwise-free features share this resolver, but the upstream
    // implementation statically references premium search-provider classes.
    // Lite keeps the call sites and replaces only that premium seam with the
    // same null contract used when no search provider is configured.
    buildApi.onResolve({ filter: /resolveCompanySearchProvider$/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      return { path: liteCompanySearchResolver };
    });
  },
};

build({
  entryPoints,
  bundle: true,
  outdir: outDir,
  outbase: rootDir,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  jsx: 'automatic',
  plugins: [liteAliases],
  loader: { '.ts': 'ts', '.js': 'js' },
  external: [
    'electron',
    'better-sqlite3',
    'keytar',
    'sqlite-vec',
    '@vectorize-io/hindsight-client',
    'onnxruntime-node',
    'pdfjs-dist',
    'pdf-parse',
    'mammoth',
  ],
  define: {
    'process.env.NATIVELY_LITE_CN': JSON.stringify('1'),
  },
  logLevel: 'warning',
}).then(() => {
  console.log(`[build-electron-lite] Built ${entryPoints.length} entry points; custom REST STT enabled.`);
}).catch((error) => {
  console.error('[build-electron-lite] Build failed:', error);
  process.exit(1);
});
