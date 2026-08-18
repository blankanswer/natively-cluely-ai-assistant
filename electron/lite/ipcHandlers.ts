import { ipcMain } from 'electron';
import type { AppState } from '../main';
import { initializeIpcHandlers as initializeUpstreamIpcHandlers } from '../ipcHandlers';
import { CredentialsManager, resolveSttTestKey } from '../services/CredentialsManager';
import {
  describeOpenAICompatibleSttError,
  resolveOpenAICompatibleTranscriptionEndpoint,
  transcribeOpenAICompatibleWav,
} from './openAICompatibleStt';
import {
  installLiteAssistantRuntime,
  testLiteAssistantConnection,
} from './openAICompatibleAssistant';

function makeProbeWav(): Buffer {
  const sampleRate = 16_000;
  const durationSeconds = 0.35;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 1200);
    pcm.writeInt16LE(sample, i * 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

/**
 * Keep a guaranteed recovery surface for this iteration. Tray-only stealth is
 * the preferred end state, but it should replace this only after tray lifecycle
 * recovery is made authoritative on every cold-start/minimize path.
 */
function keepLiteLauncherRecoverable(appState: AppState): void {
  if (process.platform !== 'win32') return;
  const launcher = appState.getWindowHelper().getLauncherWindow();
  if (!launcher || launcher.isDestroyed()) return;
  try { launcher.setSkipTaskbar(false); }
  catch (error) { console.warn('[LiteCN] Failed to keep launcher in taskbar:', error); }
}

function installLiteTaskbarRecoveryPolicy(appState: AppState): void {
  if (process.platform !== 'win32') return;
  const windowHelper = appState.getWindowHelper();
  const marker = windowHelper as unknown as { __liteTaskbarRecoveryInstalled?: boolean };
  if (marker.__liteTaskbarRecoveryInstalled) return;
  marker.__liteTaskbarRecoveryInstalled = true;
  windowHelper.syncLauncherTaskbarForStealth = () => keepLiteLauncherRecoverable(appState);
}

function openLiteSettings(appState: AppState, tab: string): void {
  const launcher = appState.getWindowHelper().getLauncherWindow();
  if (!launcher || launcher.isDestroyed()) return;
  launcher.webContents.send('settings:open-tab', tab);
  if (appState.getUndetectable()) {
    launcher.showInactive();
    appState.reassertUndetectableStealth();
  } else {
    launcher.show();
    launcher.focus();
  }
  keepLiteLauncherRecoverable(appState);
}

export function initializeIpcHandlers(appState: AppState): void {
  initializeUpstreamIpcHandlers(appState);
  installLiteTaskbarRecoveryPolicy(appState);
  installLiteAssistantRuntime(appState);

  // ── Lite recovery/safety overrides ───────────────────────────────────────
  ipcMain.removeHandler('set-undetectable');
  ipcMain.handle('set-undetectable', async (_event, state: boolean) => {
    appState.setUndetectable(Boolean(state));
    keepLiteLauncherRecoverable(appState);
    return { success: true, state: appState.getUndetectable() };
  });

  ipcMain.removeHandler('settings:open-tab');
  ipcMain.handle('settings:open-tab', async (_event, tab: string) => {
    openLiteSettings(appState, tab || 'general');
    return { success: true };
  });

  ipcMain.removeHandler('toggle-settings-window');
  ipcMain.handle('toggle-settings-window', async (_event, payload: { x?: number; y?: number } = {}) => {
    const { x, y } = payload || {};
    if (typeof x === 'number' && typeof y === 'number') {
      appState.settingsWindowHelper.toggleWindow(x, y);
      return { success: true, surface: 'quick-settings' };
    }
    openLiteSettings(appState, 'audio');
    return { success: true, surface: 'lite-settings', tab: 'audio' };
  });

  // Renderer Hide means collapse only. Do not hide the BrowserWindows which
  // contain the very Show button needed to reverse it.
  ipcMain.removeHandler('hide-window');
  ipcMain.handle('hide-window', async (event) => {
    const wh = appState.getWindowHelper();
    const overlay = wh.getOverlayWindow();
    if (overlay && !overlay.isDestroyed() && overlay.webContents.id === event.sender.id) {
      wh.setOverlayHoverInteractive(false);
      return { success: true, collapsedOnly: true };
    }
    wh.hideMainWindow();
    return { success: true, collapsedOnly: false };
  });

  const forcePassthroughOff = () => {
    appState.setOverlayMousePassthrough(false);
    return { success: true, enabled: false, disabledInLite: true };
  };
  ipcMain.removeHandler('set-overlay-mouse-passthrough');
  ipcMain.handle('set-overlay-mouse-passthrough', async () => forcePassthroughOff());
  ipcMain.removeHandler('toggle-overlay-mouse-passthrough');
  ipcMain.handle('toggle-overlay-mouse-passthrough', async () => forcePassthroughOff());
  ipcMain.removeHandler('get-overlay-mouse-passthrough');
  ipcMain.handle('get-overlay-mouse-passthrough', async () => false);

  // ── Assistant test ───────────────────────────────────────────────────────
  // The renderer already has a safe `testLlmConnection` preload method. In Lite,
  // the visible provider surface is one OpenAI-compatible Assistant, so reuse
  // that existing bridge and route the OpenAI test option to the exact Lite
  // endpoint/model transport instead of adding a flavor-only preload API.
  ipcMain.removeHandler('test-llm-connection');
  ipcMain.handle('test-llm-connection', async (_event, provider: string) => {
    if (provider === 'openai') return testLiteAssistantConnection();
    return { success: false, error: 'Lite CN 仅启用自定义 OpenAI-compatible Assistant。' };
  });

  // Kept as a main-side diagnostic channel for future tooling; settings uses
  // the existing test-llm-connection preload bridge above.
  ipcMain.removeHandler('lite:test-assistant-connection');
  ipcMain.handle('lite:test-assistant-connection', async () => testLiteAssistantConnection());

  // ── OpenAI-compatible REST STT probe ─────────────────────────────────────
  ipcMain.removeHandler('test-stt-connection');
  ipcMain.handle(
    'test-stt-connection',
    async (
      _event,
      provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox',
      apiKey: string,
    ) => {
      if (provider !== 'openai') {
        return { success: false, error: 'Lite CN 仅启用 OpenAI-compatible REST STT。' };
      }
      const resolvedKey = resolveSttTestKey('openai', apiKey);
      if (!resolvedKey.ok) return { success: false, error: resolvedKey.error };
      const cm = CredentialsManager.getInstance();
      const endpointOrBaseUrl = cm.getOpenAiSttBaseUrl();
      const model = cm.getGroqSttModel().trim() || 'whisper-1';
      try {
        const endpoint = resolveOpenAICompatibleTranscriptionEndpoint(endpointOrBaseUrl);
        await transcribeOpenAICompatibleWav({
          apiKey: resolvedKey.apiKey,
          endpointOrBaseUrl: endpoint,
          model,
          wav: makeProbeWav(),
          language: 'zh',
          timeoutMs: 15_000,
        });
        return { success: true, endpoint, model };
      } catch (error: any) {
        return {
          success: false,
          error: describeOpenAICompatibleSttError(error, endpointOrBaseUrl, model),
        };
      }
    },
  );
}
