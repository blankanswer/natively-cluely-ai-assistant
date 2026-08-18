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
 * Lite Windows recovery contract:
 *   visible       -> launcher has a taskbar entry + tray is present
 *   undetectable  -> launcher is removed from taskbar + tray stays present
 *
 * The upstream commercial stealth policy hides BOTH the tray and taskbar while
 * undetectable. That is deliberately too aggressive for Lite: it creates a
 * lock-out after minimize/hide. The tray is the permanent recovery surface.
 */
function syncLiteWindowsRecoverySurfaces(appState: AppState): void {
  if (process.platform !== 'win32') return;

  // Upstream setUndetectable(true) destroys the tray before asking
  // WindowHelper to sync the taskbar. Re-create it here. showTray() is
  // idempotent, so this is safe on every cold-start/toggle/show path.
  appState.showTray();

  const launcher = appState.getWindowHelper().getLauncherWindow();
  if (!launcher || launcher.isDestroyed()) return;
  try {
    launcher.setSkipTaskbar(appState.getUndetectable());
  } catch (error) {
    console.warn('[LiteCN] Failed to synchronize launcher taskbar state:', error);
  }
}

function installLiteWindowsRecoveryPolicy(appState: AppState): void {
  if (process.platform !== 'win32') return;
  const windowHelper = appState.getWindowHelper();
  const marker = windowHelper as unknown as { __liteTrayRecoveryInstalled?: boolean };
  if (marker.__liteTrayRecoveryInstalled) return;
  marker.__liteTrayRecoveryInstalled = true;

  // This method is called during launcher creation as well as every
  // setUndetectable transition. Replacing the instance method before the
  // BrowserWindow is created makes the tray/taskbar state correct even when a
  // session cold-starts with undetectable=true persisted from last time.
  windowHelper.syncLauncherTaskbarForStealth = () => {
    syncLiteWindowsRecoverySurfaces(appState);
  };
}

function showLiteLauncher(appState: AppState): void {
  const wh = appState.getWindowHelper();
  // Apply skipTaskbar before showing so Windows never flashes a taskbar button
  // in undetectable mode while restoring from the tray.
  syncLiteWindowsRecoverySurfaces(appState);
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
  syncLiteWindowsRecoverySurfaces(appState);
  wh.setWindowMode('overlay', true);
  const overlay = wh.getOverlayWindow();
  if (overlay && !overlay.isDestroyed()) {
    // Tray recovery always restores a usable panel, not a fully collapsed shell.
    overlay.webContents.send('ensure-expanded');
    overlay.showInactive();
  }
  if (appState.getUndetectable()) appState.reassertUndetectableStealth();
}

function openLiteSettings(appState: AppState, tab: string): void {
  const launcher = appState.getWindowHelper().getLauncherWindow();
  if (!launcher || launcher.isDestroyed()) return;

  syncLiteWindowsRecoverySurfaces(appState);
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
 * Replace the broad upstream tray menu with the Lite recovery menu. The tray
 * itself remains created by AppState.showTray(), so icon selection and native
 * lifecycle stay upstream-compatible; only the menu/actions are flavor-specific.
 */
function installLiteTrayMenu(appState: AppState): void {
  if (process.platform !== 'win32') return;
  const state = appState as any;
  if (state.__liteTrayMenuInstalled) return;
  state.__liteTrayMenuInstalled = true;

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
            syncLiteWindowsRecoverySurfaces(appState);
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
}

export function initializeIpcHandlers(appState: AppState): void {
  initializeUpstreamIpcHandlers(appState);
  installLiteTrayMenu(appState);
  installLiteWindowsRecoveryPolicy(appState);
  installLiteAssistantRuntime(appState);

  // ── Lite recovery/safety overrides ───────────────────────────────────────
  ipcMain.removeHandler('set-undetectable');
  ipcMain.handle('set-undetectable', async (_event, state: boolean) => {
    appState.setUndetectable(Boolean(state));
    syncLiteWindowsRecoverySurfaces(appState);
    return {
      success: true,
      state: appState.getUndetectable(),
      recoverySurface: process.platform === 'win32' ? 'tray' : 'native',
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

  // Hide/Show is a renderer expansion state, NOT capture visibility. The old
  // collapse path called hide-window after its fade, which hid the overlay,
  // pill and therefore the Show button itself. In Lite, an overlay-originated
  // hide leaves all BrowserWindows alive and only makes the transparent shell
  // click-through; the independent pill remains the recovery control.
  ipcMain.removeHandler('hide-window');
  ipcMain.handle('hide-window', async (event) => {
    const wh = appState.getWindowHelper();
    const overlay = wh.getOverlayWindow();
    if (overlay && !overlay.isDestroyed() && overlay.webContents.id === event.sender.id) {
      wh.setOverlayHoverInteractive(false);
      return { success: true, collapsedOnly: true };
    }
    wh.hideMainWindow();
    syncLiteWindowsRecoverySurfaces(appState);
    return { success: true, collapsedOnly: false };
  });

  // Whole-window passthrough has no mouse-reachable recovery by construction.
  // Keep the authoritative state false in Lite; transparent margins still use
  // WindowHelper's bounded hover click-through policy.
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
  // Settings reuses the existing safe OpenAI test bridge, but in Lite it probes
  // the exact configured custom Assistant via the same SSE transport used by a
  // meeting. Success means real delta.content arrived, not merely HTTP 200.
  ipcMain.removeHandler('test-llm-connection');
  ipcMain.handle('test-llm-connection', async (_event, provider: string) => {
    if (provider === 'openai') return testLiteAssistantConnection();
    return { success: false, error: 'Lite CN 仅启用自定义 OpenAI-compatible Assistant。' };
  });

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
