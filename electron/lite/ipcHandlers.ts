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
 * Lite wrapper around the upstream IPC surface.
 *
 * We initialize upstream first to retain all app behavior, then replace only
 * `test-stt-connection`. The upstream OpenAI probe had two Lite-breaking
 * assumptions: it appended `/v1/audio/transcriptions` even when a full endpoint
 * was supplied, and it always sent `whisper-1` instead of the user's model.
 */
export function initializeIpcHandlers(appState: AppState): void {
  initializeUpstreamIpcHandlers(appState);

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
