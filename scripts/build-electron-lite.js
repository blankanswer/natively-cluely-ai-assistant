#!/usr/bin/env node
/**
 * Lite CN Electron build.
 *
 * Keeps upstream sources intact while swapping the OpenAI realtime STT module
 * for the pure REST Lite adapter. Premium sources are never added as entry
 * points, and premium-only resolver seams are replaced with Lite stubs, so this
 * build does not require the private premium submodule.
 *
 * Lite-only source transforms below intentionally fix macOS test-build behavior
 * without changing the upstream/production flavor:
 * - use the app-managed encrypted credential fallback on packaged Lite macOS,
 *   avoiding unstable ad-hoc Keychain ACL prompts across rebuilds;
 * - treat Electron's screen TCC status as advisory and probe the real capture
 *   API, because macOS can keep getMediaAccessStatus('screen') stale after the
 *   user has enabled Screen & System Audio Recording.
 */
const { build } = require('esbuild');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const electronDir = path.join(rootDir, 'electron');
const outDir = path.join(rootDir, 'dist-electron');
const liteStt = path.join(electronDir, 'audio', 'LiteOpenAICompatibleSTT.ts');
const liteCompanySearchResolver = path.join(electronDir, 'lite', 'resolveCompanySearchProvider.ts');
const liteIpcHandlers = path.join(electronDir, 'lite', 'ipcHandlers.ts');
const upstreamCompanySearchResolver = path.join(electronDir, 'services', 'resolveCompanySearchProvider.ts');
const upstreamIpcHandlers = path.join(electronDir, 'ipcHandlers.ts');
const credentialsManager = path.join(electronDir, 'services', 'CredentialsManager.ts');
const screenshotHelper = path.join(electronDir, 'ScreenshotHelper.ts');

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

    buildApi.onResolve({ filter: /resolveCompanySearchProvider$/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      return { path: liteCompanySearchResolver };
    });

    // Main's ./ipcHandlers import is replaced by the Lite wrapper. The wrapper
    // itself imports ../ipcHandlers to reach upstream and must not recurse.
    buildApi.onResolve({ filter: /(?:^|\/)ipcHandlers$/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      if (path.resolve(args.importer) === path.resolve(liteIpcHandlers)) return null;
      const resolved = path.resolve(path.dirname(args.importer), args.path);
      if (resolved === upstreamIpcHandlers || `${resolved}.ts` === upstreamIpcHandlers) {
        return { path: liteIpcHandlers };
      }
      return null;
    });

    // An ad-hoc macOS build has no stable Developer-ID Keychain ACL. Reusing
    // Electron safeStorage across frequently re-signed CI builds causes the
    // "wants to use confidential information stored in natively Safe Storage"
    // password dialog. Lite macOS deliberately uses the existing machine-bound
    // AES-GCM fallback instead. Windows and non-Lite builds are untouched.
    buildApi.onLoad({ filter: /CredentialsManager\.ts$/ }, (args) => {
      if (path.resolve(args.path) !== path.resolve(credentialsManager)) return null;
      let source = fs.readFileSync(args.path, 'utf8');
      const needle = 'safeStorage.isEncryptionAvailable()';
      if (!source.includes(needle)) throw new Error('[Lite transform] CredentialsManager safeStorage probe marker missing');
      source = source.split(needle).join('liteSafeStorageAvailable()');
      const importMarker = "import { deriveFallbackKey, encryptCredentialBlob, decryptCredentialBlob } from './credentialFallbackCrypto';\n";
      if (!source.includes(importMarker)) throw new Error('[Lite transform] CredentialsManager import marker missing');
      source = source.replace(
        importMarker,
        importMarker + `\nfunction liteSafeStorageAvailable(): boolean {\n` +
          `    if (process.env.NATIVELY_LITE_CN === '1' && process.platform === 'darwin' && app.isPackaged) return false;\n` +
          `    return safeStorage.isEncryptionAvailable();\n` +
          `}\n`,
      );
      return { contents: source, loader: 'ts' };
    });

    // macOS can report screen='denied' from Electron's cached TCC status while
    // desktopCapturer/ScreenCaptureKit are already authorized (especially just
    // after enabling the toggle and restarting). The upstream helper used that
    // stale status as a hard precondition, which blocked selective screenshots
    // before the real capture API got a chance to prove access. In Lite, keep
    // the status only as diagnostics and let desktopCapturer be authoritative.
    buildApi.onLoad({ filter: /ScreenshotHelper\.ts$/ }, (args) => {
      if (path.resolve(args.path) !== path.resolve(screenshotHelper)) return null;
      let source = fs.readFileSync(args.path, 'utf8');
      const start = source.indexOf('function assertScreenRecordingPermission(): void {');
      const endMarker = '/**\n * Finds the display that best contains the given rectangle.';
      const end = source.indexOf(endMarker, start);
      if (start < 0 || end < 0) throw new Error('[Lite transform] ScreenshotHelper permission guard markers missing');
      const replacement = `function assertScreenRecordingPermission(): void {\n` +
        `  if (process.platform !== 'darwin' || !app.isPackaged) return;\n` +
        `  try {\n` +
        `    const status = systemPreferences.getMediaAccessStatus('screen');\n` +
        `    if (status !== 'granted') {\n` +
        `      console.warn('[ScreenshotHelper][LiteCN] Electron screen TCC status is ' + status + '; probing desktopCapturer instead of failing early.');\n` +
        `    }\n` +
        `  } catch (error) {\n` +
        `    console.warn('[ScreenshotHelper][LiteCN] Could not read screen TCC status; probing capture API:', error);\n` +
        `  }\n` +
        `}\n\n`;
      source = source.slice(0, start) + replacement + source.slice(end);
      return { contents: source, loader: 'ts' };
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
  console.log(`[build-electron-lite] Built ${entryPoints.length} entry points; custom REST STT + Lite macOS fixes enabled.`);
}).catch((error) => {
  console.error('[build-electron-lite] Build failed:', error);
  process.exit(1);
});
