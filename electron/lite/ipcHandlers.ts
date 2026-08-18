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
 * Windows Lite currently keeps the launcher taskbar entry as the guaranteed
 * recovery surface. The user's preferred end state is tray-only while stealth
 * is enabled; that change is intentionally deferred until the tray lifecycle is
 * made authoritative, because removing both surfaces is a lock-out regression.
 */
function keepLiteLauncherRecoverable(appState: AppState): void {
  if (process.platform !== 'win32') return;
  const launcher = appState.getWindowHelper().getLauncherWindow();
  if (!launcher || launcher.isDestroyed()) return;
  try {
    launcher.setSkipTaskbar(false);
  } catch (error) {
    console.warn('[LiteCN] Failed to keep launcher in taskbar:', error);
  }
}

function installLiteTaskbarRecoveryPolicy(appState: AppState): void {
  if (process.platform !== 'win32') return;
  const windowHelper = appState.getWindowHelper();
  const marker = windowHelper as unknown as { __liteTaskbarRecoveryInstalled?: boolean };
  if (marker.__liteTaskbarRecoveryInstalled) return;
  marker.__liteTaskbarRecoveryInstalled = true;

  windowHelper.syncLauncherTaskbarForStealth = () => {
    keepLiteLauncherRecoverable(appState);
  };
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

  // -------------------------------------------------------------------------
  // Lite recovery/safety overrides
  // -------------------------------------------------------------------------

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

  // NativelyInterface's historic collapse path invokes `hide-window` after its
  // CSS fade. That also hides the separate TopPill BrowserWindow, so there is no
  // mouse-reachable Show control to reverse the action. In Lite, an overlay-
  // initiated hide means "collapse the shell": leave the OS windows alive and
  // make the transparent shell click-through. Full app hiding still goes through
  // main-process global/tray window actions, not this renderer collapse call.
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

  // -------------------------------------------------------------------------
  // Assistant probe — exact same direct Chat Completions transport used at run
  // time in Lite (including the selected model and optional vision payload).
  // -------------------------------------------------------------------------

  ipcMain.removeHandler('lite:test-assistant-connection');
  ipcMain.handle('lite:test-assistant-connection', async () => testLiteAssistantConnection());

  // -------------------------------------------------------------------------
  // OpenAI-compatible REST STT probe
  // -------------------------------------------------------------------------

  ipcMain.removeHandler('test-stt-connection');
  ipcMain.handle(
    'test-stt-connection',
    async (
      _event,
      provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox',
      apiKey: string,
    ) => {
      if (provider !== 'openai') {
        return {
          success: false,
          error: 'Lite CN 仅启用 OpenAI-compatible REST STT。',
        };
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
        return {
          success: true,
          endpoint,
          model,
        };
      } catch (error: any) {
        return {
          success: false,
          error: describeOpenAICompatibleSttError(error, endpointOrBaseUrl, model),
        };
      }
    },
  );
}
