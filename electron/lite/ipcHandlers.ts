import { ipcMain } from 'electron';
import type { AppState } from '../main';
import { initializeIpcHandlers as initializeUpstreamIpcHandlers } from '../ipcHandlers';
import { CredentialsManager, resolveSttTestKey } from '../services/CredentialsManager';
import {
  describeOpenAICompatibleSttError,
  resolveOpenAICompatibleTranscriptionEndpoint,
  transcribeOpenAICompatibleWav,
} from './openAICompatibleStt';

function makeProbeWav(): Buffer {
  const sampleRate = 16_000;
  const durationSeconds = 0.35;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const pcm = Buffer.alloc(sampleCount * 2);

  // A quiet 440 Hz tone is deterministic and avoids gateways that reject a
  // completely silent/zero-length probe while still being harmless to STT.
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
 * Windows Lite must always keep at least one ordinary recovery surface.
 *
 * Upstream stealth intentionally removes the launcher from the taskbar and also
 * hides the tray. That is useful for the commercial stealth workflow, but in a
 * personal Lite build it creates a lock-out: minimize the launcher while
 * undetectable is enabled and there is no visible UI left to restore it. Keep
 * content protection / undetectable behavior, but keep the launcher taskbar
 * button as the escape hatch.
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

/**
 * Lite wrapper around the upstream IPC surface.
 *
 * Upstream is initialized first so the broad app surface remains available.
 * Lite then replaces only the places where upstream assumptions are unsafe or
 * misleading for this flavor:
 *   - STT probe uses the exact same endpoint/model request as live STT;
 *   - Windows stealth keeps a taskbar recovery path;
 *   - persistent whole-overlay mouse passthrough is disabled (it otherwise
 *     makes its own off-switch unclickable);
 *   - a banner's generic "Open Settings" action opens the real Lite settings
 *     instead of the tiny legacy quick-settings popover.
 */
export function initializeIpcHandlers(appState: AppState): void {
  initializeUpstreamIpcHandlers(appState);

  // -------------------------------------------------------------------------
  // Lite recovery/safety overrides
  // -------------------------------------------------------------------------

  ipcMain.removeHandler('set-undetectable');
  ipcMain.handle('set-undetectable', async (_event, state: boolean) => {
    appState.setUndetectable(Boolean(state));
    keepLiteLauncherRecoverable(appState);
    return { success: true, state: appState.getUndetectable() };
  });

  // `settings:open-tab` is the canonical full SettingsOverlay route. Replacing
  // it lets us preserve the taskbar escape hatch even after upstream stealth is
  // reasserted during a showInactive().
  ipcMain.removeHandler('settings:open-tab');
  ipcMain.handle('settings:open-tab', async (_event, tab: string) => {
    openLiteSettings(appState, tab || 'general');
    return { success: true };
  });

  // Upstream's `toggle-settings-window` opens a 180px legacy quick-settings
  // popover. Overlay controls pass coordinates and still benefit from that
  // compact popup. Warning banners call it with NO coordinates: in Lite that
  // must open the real settings surface, otherwise "打开设置" appears to do
  // nothing useful and cannot reach audio/STT configuration.
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

  // Whole-window passthrough has no mouse-reachable recovery by construction:
  // once every overlay/pill/toggle BrowserWindow ignores mouse events, the same
  // PointerOff button cannot receive the click that would turn it back off.
  // Lite prioritizes a recoverable UI, so keep the authoritative state false.
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
      // Lite currently persists this non-secret field through the existing
      // Groq-model setter for backward compatibility. Unlike the old probe,
      // always read the user's value instead of hard-coding whisper-1.
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
