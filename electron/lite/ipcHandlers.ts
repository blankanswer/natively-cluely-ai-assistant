import { app, ipcMain, Menu } from 'electron';
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
 * Lite recovery contract.
 *
 * Windows:
 *   visible       -> taskbar entry + tray
 *   undetectable  -> no taskbar entry + tray remains as recovery surface
 *
 * macOS:
 *   visible       -> Dock + menu-bar status item
 *   undetectable  -> Dock hidden + menu-bar status item remains
 *
 * Upstream's commercial stealth policy may hide every recovery surface. That is
 * deliberately too aggressive for Lite: a minimized/hidden app can become
 * impossible to bring back. The tray/menu-bar item is therefore authoritative.
 */
function syncLiteRecoverySurfaces(appState: AppState): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;

  appState.showTray();

  if (process.platform === 'win32') {
    const launcher = appState.getWindowHelper().getLauncherWindow();
    if (!launcher || launcher.isDestroyed()) return;
    try {
      launcher.setSkipTaskbar(appState.getUndetectable());
    } catch (error) {
      console.warn('[LiteCN] Failed to synchronize Windows taskbar state:', error);
    }
    return;
  }

  try {
    const dock = (app as any).dock;
    if (dock) {
      if (appState.getUndetectable()) {
        dock.hide();
      } else {
        const result = dock.show();
        if (result && typeof result.catch === 'function') {
          void result.catch((error: unknown) => {
            console.warn('[LiteCN] Failed to show macOS Dock icon:', error);
          });
        }
      }
    }
  } catch (error) {
    console.warn('[LiteCN] Failed to synchronize macOS Dock state:', error);
  }
}

function installLiteRecoveryPolicy(appState: AppState): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const windowHelper = appState.getWindowHelper();
  const marker = windowHelper as unknown as { __liteRecoveryInstalled?: boolean };
  if (marker.__liteRecoveryInstalled) return;
  marker.__liteRecoveryInstalled = true;

  windowHelper.syncLauncherTaskbarForStealth = () => {
    syncLiteRecoverySurfaces(appState);
  };
}

function showLiteLauncher(appState: AppState): void {
  const wh = appState.getWindowHelper();
  syncLiteRecoverySurfaces(appState);
  wh.setWindowMode('launcher', appState.getUndetectable());

  const launcher = wh.getLauncherWindow();
  if (!launcher || launcher.isDestroyed()) return;
  if (appState.getUndetectable()) {
    launcher.showInactive();
    appState.reassertUndetectableStealth();
  } else {
    launcher.show();
    launcher.focus();
  }
}

function showLiteMeeting(appState: AppState): void {
  if (!appState.getIsMeetingActive()) {
    showLiteLauncher(appState);
    return;
  }

  const wh = appState.getWindowHelper();
  syncLiteRecoverySurfaces(appState);
  wh.setOverlayHoverInteractive(true);
  wh.setWindowMode('overlay', true);
  const overlay = wh.getOverlayWindow();
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send('ensure-expanded');
    overlay.showInactive();
    wh.setOverlayHoverInteractive(true);
  }
  if (appState.getUndetectable()) appState.reassertUndetectableStealth();
}

function openLiteSettings(appState: AppState, tab: string): void {
  const launcher = appState.getWindowHelper().getLauncherWindow();
  if (!launcher || launcher.isDestroyed()) return;

  syncLiteRecoverySurfaces(appState);
  launcher.webContents.send('settings:open-tab', tab);
  if (appState.getUndetectable()) {
    launcher.showInactive();
    appState.reassertUndetectableStealth();
  } else {
    launcher.show();
    launcher.focus();
  }
}

/**
 * Replace the broad upstream tray/status menu with a small permanent Lite
 * recovery menu. Electron Tray maps to the Windows system tray and the macOS
 * menu-bar status area, so the same actions work on both platforms.
 */
function installLiteTrayMenu(appState: AppState): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const state = appState as any;
  if (state.__liteTrayMenuInstalled) return;
  state.__liteTrayMenuInstalled = true;

  // Upstream's macOS stealth enforcement loop repeatedly calls hideTray() while
  // undetectable (not just once at toggle time). A one-shot showTray() would
  // therefore disappear again a moment later. Lite treats the menu-bar item as
  // a non-negotiable recovery control, so suppress tray destruction on macOS.
  if (process.platform === 'darwin') {
    state.hideTray = () => {
      // Intentionally no-op in Lite. The process exit tears the status item down
      // naturally; stealth only hides the Dock tile, never this recovery item.
    };
  }

  state.centerAndShowWindow = () => showLiteLauncher(appState);
  state.updateTrayMenu = () => {
    const tray = state.tray;
    if (!tray || tray.isDestroyed?.()) return;

    tray.setToolTip('Natively Lite CN');
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: '显示 Natively',
        click: () => showLiteLauncher(appState),
      },
      {
        label: '显示会议窗口',
        click: () => showLiteMeeting(appState),
      },
      {
        label: '设置',
        click: () => openLiteSettings(appState, 'general'),
      },
      { type: 'separator' },
      {
        label: '结束会议',
        click: async () => {
          if (!appState.getIsMeetingActive()) return;
          try {
            await appState.endMeeting();
          } finally {
            syncLiteRecoverySurfaces(appState);
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => app.quit(),
      },
    ]));
  };

  appState.showTray();
  state.updateTrayMenu();
}

export function initializeIpcHandlers(appState: AppState): void {
  initializeUpstreamIpcHandlers(appState);
  installLiteTrayMenu(appState);
  installLiteRecoveryPolicy(appState);
  installLiteAssistantRuntime(appState);
  syncLiteRecoverySurfaces(appState);

  ipcMain.removeHandler('set-undetectable');
  ipcMain.handle('set-undetectable', async (_event, state: boolean) => {
    appState.setUndetectable(Boolean(state));
    syncLiteRecoverySurfaces(appState);
    return {
      success: true,
      state: appState.getUndetectable(),
      recoverySurface:
        process.platform === 'darwin'
          ? 'menu-bar'
          : process.platform === 'win32'
            ? 'tray'
            : 'native',
    };
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

  ipcMain.removeHandler('show-window');
  ipcMain.handle('show-window', async (_event, inactive?: boolean) => {
    const wh = appState.getWindowHelper();
    wh.setOverlayHoverInteractive(true);
    appState.showMainWindow(inactive);
    wh.setOverlayHoverInteractive(true);
    syncLiteRecoverySurfaces(appState);
    return { success: true };
  });

  ipcMain.removeHandler('hide-window');
  ipcMain.handle('hide-window', async (event) => {
    const wh = appState.getWindowHelper();
    const overlay = wh.getOverlayWindow();
    if (overlay && !overlay.isDestroyed() && overlay.webContents.id === event.sender.id) {
      wh.setOverlayHoverInteractive(true);
      return { success: true, collapsedOnly: true };
    }
    wh.hideMainWindow();
    syncLiteRecoverySurfaces(appState);
    return { success: true, collapsedOnly: false };
  });

  const forcePassthroughOff = () => {
    appState.setOverlayMousePassthrough(false);
    appState.getWindowHelper().setOverlayHoverInteractive(true);
    return { success: true, enabled: false, disabledInLite: true };
  };
  ipcMain.removeHandler('set-overlay-mouse-passthrough');
  ipcMain.handle('set-overlay-mouse-passthrough', async () => forcePassthroughOff());
  ipcMain.removeHandler('toggle-overlay-mouse-passthrough');
  ipcMain.handle('toggle-overlay-mouse-passthrough', async () => forcePassthroughOff());
  ipcMain.removeHandler('get-overlay-mouse-passthrough');
  ipcMain.handle('get-overlay-mouse-passthrough', async () => false);

  ipcMain.removeHandler('test-llm-connection');
  ipcMain.handle('test-llm-connection', async (_event, provider: string) => {
    if (provider === 'openai') return testLiteAssistantConnection();
    return { success: false, error: 'Lite CN 仅启用自定义 OpenAI-compatible Assistant。' };
  });

  ipcMain.removeHandler('lite:test-assistant-connection');
  ipcMain.handle('lite:test-assistant-connection', async () => testLiteAssistantConnection());

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
