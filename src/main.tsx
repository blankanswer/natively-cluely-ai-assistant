import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { LanguageProvider } from "./i18n"
import "./index.css"

// ── Renderer crash/hang diagnostics ─────────────────────────────────────────
// Surface uncaught errors and unhandled promise rejections through console.error
// so the main process's `console-message` listener (WindowHelper.attachRenderer-
// Diagnostics) forwards them to ~/Documents/natively_debug.log. Without this, an
// early renderer throw (before React mounts) leaves the user on a black/logo
// screen with NO trace anywhere. Registered FIRST so it also covers the theme/
// platform setup below.
window.addEventListener('error', (event) => {
  const e = event.error;
  const where = `${event.filename ?? '?'}:${event.lineno ?? 0}:${event.colno ?? 0}`;
  // eslint-disable-next-line no-console
  console.error(`[renderer] window.onerror ${event.message} @ ${where}`, e?.stack ?? '');
});
window.addEventListener('unhandledrejection', (event) => {
  const r = event.reason;
  // eslint-disable-next-line no-console
  console.error('[renderer] unhandledrejection', r?.stack ?? r?.message ?? String(r));
});
// Positive "the bundle reached main.tsx" marker — distinguishes "JS never ran"
// (missing asset / CSP block) from "JS ran but hung later".
// eslint-disable-next-line no-console
console.log('[renderer] main.tsx evaluating');

const THEME_CACHE_KEY = 'natively_resolved_theme';
const LITE_CN_INIT_KEY = 'natively_lite_cn_initialized_v1';
const LANGUAGE_STORAGE_KEY = 'natively_lang';
const launcherIsolation = new URLSearchParams(window.location.search).get('isolate');

/**
 * Lite CN defaults are deliberately first-run only. Existing users keep their
 * explicit choices, and every setting remains editable from Settings afterwards.
 *
 * The upstream app already supports OpenAI-compatible custom STT base URLs and
 * API keys. Selecting the OpenAI provider here makes that REST-capable path the
 * default instead of Google Cloud, while `chinese` maps to zh-CN / zh in the
 * shared recognition-language table.
 */
function applyLiteCnFirstRunDefaults(): void {
  try {
    if (!localStorage.getItem(LANGUAGE_STORAGE_KEY)) {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh');
    }

    if (localStorage.getItem(LITE_CN_INIT_KEY)) return;
    localStorage.setItem(LITE_CN_INIT_KEY, '1');

    void window.electronAPI?.setRecognitionLanguage?.('chinese').catch(() => {});
    void window.electronAPI?.setAiResponseLanguage?.('Chinese').catch(() => {});
    void window.electronAPI?.setSttProvider?.('openai').catch(() => {});
  } catch {
    // Sandboxed/test renderers may not expose localStorage or Electron IPC.
    // LanguageProvider already has a safe fallback, so startup should continue.
  }
}

applyLiteCnFirstRunDefaults();

if (launcherIsolation === 'shell') {
  // eslint-disable-next-line no-console
  console.warn('[LeakTest] launcher shell isolation active — React root intentionally skipped');
} else {

// Set platform attribute synchronously — before React renders — so CSS selectors
// like html[data-platform="win32"] work immediately without a flash on first paint.
document.documentElement.setAttribute(
  'data-platform',
  window.electronAPI?.platform ?? (typeof process !== 'undefined' ? process.platform : '') ?? ''
);

// Step 1: Apply cached theme synchronously — before React renders.
// This ensures useResolvedTheme()'s initial useState read sees the correct value.
const cachedTheme = localStorage.getItem(THEME_CACHE_KEY) as 'light' | 'dark' | null;
document.documentElement.setAttribute('data-theme', cachedTheme ?? 'dark');

// Step 2: Confirm/correct from main process (authoritative) and keep cache in sync.
if (window.electronAPI?.getThemeMode) {
  window.electronAPI.getThemeMode().then(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  }).catch(() => {});

  window.electronAPI?.onThemeChanged?.(({ resolved }) => {
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem(THEME_CACHE_KEY, resolved);
  });
}

try {
  const rootEl = document.getElementById("root");
  if (!rootEl) {
    // eslint-disable-next-line no-console
    console.error('[renderer] FATAL: #root element not found — cannot mount React');
  } else {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </React.StrictMode>
    );
    // eslint-disable-next-line no-console
    console.log('[renderer] React root render() dispatched');
  }
} catch (err: any) {
  // A throw here means the whole app failed to mount → black/logo screen.
  // Log it so the failure has a trace in natively_debug.log instead of nothing.
  // eslint-disable-next-line no-console
  console.error('[renderer] FATAL: React mount threw', err?.stack ?? err?.message ?? String(err));
}
}
