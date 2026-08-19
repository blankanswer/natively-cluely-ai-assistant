#!/usr/bin/env node
/**
 * Lite CN Electron build.
 *
 * Keeps upstream sources intact while swapping the OpenAI realtime STT module
 * for the pure REST Lite adapter. Premium sources are never added as entry
 * points, and premium-only resolver seams are replaced with Lite stubs, so this
 * build does not require the private premium submodule.
 *
 * Lite-only source transforms intentionally keep flavor-specific behavior out
 * of the upstream production build: ad-hoc macOS credential storage/TCC fixes,
 * built-in skill editing bridges, collapsed-overlay click-through, and genuine
 * multi-turn Chat Completions history for the BYOK Assistant.
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
const liteAssistant = path.join(electronDir, 'lite', 'openAICompatibleAssistant.ts');
const upstreamCompanySearchResolver = path.join(electronDir, 'services', 'resolveCompanySearchProvider.ts');
const upstreamIpcHandlers = path.join(electronDir, 'ipcHandlers.ts');
const credentialsManager = path.join(electronDir, 'services', 'CredentialsManager.ts');
const screenshotHelper = path.join(electronDir, 'ScreenshotHelper.ts');
const preload = path.join(electronDir, 'preload.ts');

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

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`[Lite transform] ${label} marker missing`);
  return source.replace(from, to);
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

    // Lite IPC additions are injected at build time so upstream/main stays
    // untouched. Built-in skill editing lives in a small dedicated module.
    // On collapse, only the MAIN overlay becomes click-through; the separate
    // Show pill/aux window remains interactive and can always restore the UI.
    buildApi.onLoad({ filter: /ipcHandlers\.ts$/ }, (args) => {
      // Preserve the renderer's canonical conversation context when upstream
      // adds its rolling 100-second transcript snapshot. Upstream currently
      // replaces caller context wholesale; Lite merges both sources instead.
      if (path.resolve(args.path) === path.resolve(upstreamIpcHandlers)) {
        let source = fs.readFileSync(args.path, 'utf8');
        source = replaceRequired(
          source,
          'context = snapshotForContext;',
          'context = context ? `${context}\n\n${snapshotForContext}` : snapshotForContext;',
          'upstream manual-chat context merge',
        );
        return { contents: source, loader: 'ts' };
      }

      if (path.resolve(args.path) !== path.resolve(liteIpcHandlers)) return null;
      let source = fs.readFileSync(args.path, 'utf8');

      const assistantImport = `import {\n  installLiteAssistantRuntime,\n  testLiteAssistantConnection,\n} from './openAICompatibleAssistant';\n`;
      source = replaceRequired(
        source,
        assistantImport,
        `${assistantImport}import { installBuiltinSkillEditorIpc } from './builtinSkillEditor';\n`,
        'Lite IPC built-in skill import',
      );

      source = replaceRequired(
        source,
        '  initializeUpstreamIpcHandlers(appState);\n',
        '  initializeUpstreamIpcHandlers(appState);\n  installBuiltinSkillEditorIpc();\n',
        'Lite IPC built-in skill installer',
      );

      const collapsedBlock = `    if (overlay && !overlay.isDestroyed() && overlay.webContents.id === event.sender.id) {\n      wh.setOverlayHoverInteractive(true);\n      return { success: true, collapsedOnly: true };\n    }\n`;
      const clickThroughBlock = `    if (overlay && !overlay.isDestroyed() && overlay.webContents.id === event.sender.id) {\n      // Renderer collapse only hides pixels; the native BrowserWindow still\n      // occupies its old rectangle. Make ONLY that main window ignore mouse\n      // events so Finder/iMovie/etc. underneath receive clicks. The separate\n      // Lite Show pill remains interactive. show-window restores native hit\n      // testing before expanding the renderer again.\n      overlay.setIgnoreMouseEvents(true, { forward: true });\n      return { success: true, collapsedOnly: true };\n    }\n`;
      source = replaceRequired(source, collapsedBlock, clickThroughBlock, 'collapsed overlay click-through');

      return { contents: source, loader: 'ts' };
    });

    // Add Lite-only preload methods without widening the shared ElectronAPI
    // contract. The Lite settings component intentionally accesses these via an
    // `any` cast; upstream tsc therefore remains byte-for-byte unchanged.
    buildApi.onLoad({ filter: /preload\.ts$/ }, (args) => {
      if (path.resolve(args.path) !== path.resolve(preload)) return null;
      let source = fs.readFileSync(args.path, 'utf8');
      const marker = `  skillsRefresh: () => ipcRenderer.invoke('skills:list'),\n`;
      source = replaceRequired(
        source,
        marker,
        marker +
          `  skillsGetBuiltin: (id: string) => ipcRenderer.invoke('lite:skills:get-builtin', id),\n` +
          `  skillsSaveBuiltin: (id: string, content: string) => ipcRenderer.invoke('lite:skills:save-builtin', id, content),\n` +
          `  skillsResetBuiltin: (id: string) => ipcRenderer.invoke('lite:skills:reset-builtin', id),\n`,
        'preload Lite skill editor bridge',
      );
      return { contents: source, loader: 'ts' };
    });

    // The renderer serializes one canonical conversation history marker into
    // caller context. Upstream LLMHelper wraps that context into USER content
    // (`CONTEXT: ... USER QUESTION: ...`), so recover it from userMessage and
    // turn it back into REAL Chat Completions messages before the current turn.
    buildApi.onLoad({ filter: /openAICompatibleAssistant\.ts$/ }, (args) => {
      if (path.resolve(args.path) !== path.resolve(liteAssistant)) return null;
      let source = fs.readFileSync(args.path, 'utf8');
      const credentialsImport = `import { CredentialsManager } from '../services/CredentialsManager';\n`;
      source = replaceRequired(
        source,
        credentialsImport,
        credentialsImport + `import { extractLiteConversationFromPrompt } from './conversationHistory';\n`,
        'Lite Assistant history import',
      );

      const messageInit = `  const messages: ChatMessage[] = [];\n  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });\n\n  if (!imagePaths?.length) {\n`;
      const messageInitWithHistory = `  const extracted = extractLiteConversationFromPrompt(userMessage);\n  const extractedSystem = extractLiteConversationFromPrompt(systemPrompt || '');\n  const currentUserMessage = extracted.currentUserText;\n  const currentSystemPrompt = extractedSystem.currentUserText || systemPrompt;\n  const history = extracted.history.length > 0 ? extracted.history : extractedSystem.history;\n  const messages: ChatMessage[] = [];\n  if (currentSystemPrompt) messages.push({ role: 'system', content: currentSystemPrompt });\n  messages.push(...history);\n\n  if (!imagePaths?.length) {\n`;
      source = replaceRequired(source, messageInit, messageInitWithHistory, 'Lite Assistant real message history');
      source = replaceRequired(
        source,
        `    messages.push({ role: 'user', content: userMessage });\n`,
        `    messages.push({ role: 'user', content: currentUserMessage });\n`,
        'Lite Assistant clean current text message',
      );
      source = replaceRequired(
        source,
        `  const content: Array<Record<string, unknown>> = [{ type: 'text', text: userMessage }];\n`,
        `  const content: Array<Record<string, unknown>> = [{ type: 'text', text: currentUserMessage }];\n`,
        'Lite Assistant clean current multimodal message',
      );
      return { contents: source, loader: 'ts' };
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
  console.log(`[build-electron-lite] Built ${entryPoints.length} entry points; custom REST STT + unified Lite context enabled.`);
}).catch((error) => {
  console.error('[build-electron-lite] Build failed:', error);
  process.exit(1);
});
