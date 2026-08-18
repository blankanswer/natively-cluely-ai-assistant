import { EventEmitter } from 'events';
import axios from 'axios';
import FormData from 'form-data';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { CredentialsManager } from '../services/CredentialsManager';
import { getLiteSttModel } from '../lite/settings';

const TARGET_RATE = 16_000;
const MIN_BUFFER_BYTES = 4_000;
const SAFETY_NET_MS = 10_000;
const SILENCE_RMS_THRESHOLD = 50;
const DEFAULT_BASE = 'https://api.openai.com';

function resolveEndpoint(value?: string): string {
  const raw = (value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/audio/transcriptions`;
  return `${raw}/v1/audio/transcriptions`;
}

function configuredModel(): string {
  // Lite reuses the already-exposed setGroqSttModel IPC as a backwards-
  // compatible non-secret model preference. CredentialsManager does not expose
  // a public getter for that legacy field, so this narrow read is intentionally
  // isolated here instead of spreading private-state access across the app.
  const cm = CredentialsManager.getInstance() as unknown as {
    credentials?: { groqSttModel?: string };
  };
  const legacy = cm.credentials?.groqSttModel?.trim();
  return legacy || getLiteSttModel();
}

/**
 * Lite CN STT implementation.
 *
 * It intentionally implements the same public contract as OpenAIStreamingSTT,
 * but never opens OpenAI's Realtime WebSocket. Audio is buffered behind the
 * native VAD, normalized to 16 kHz mono WAV, and sent to an OpenAI-compatible
 * multipart `/audio/transcriptions` endpoint using the user's own Bearer key.
 */
export class OpenAIStreamingSTT extends EventEmitter {
  private apiKey: string;
  private endpoint: string;
  private inputSampleRate = TARGET_RATE;
  private numChannels = 1;
  private languageKey = 'chinese';
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private isActive = false;
  private isUploading = false;
  private flushPending = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(apiKey: string, baseUrl?: string) {
    super();
    this.apiKey = apiKey;
    this.endpoint = resolveEndpoint(baseUrl);
    console.log(`[LiteSTT] REST endpoint: ${this.endpoint}`);
  }

  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  public setSampleRate(rate: number): void {
    if (Number.isFinite(rate) && rate > 0) this.inputSampleRate = rate;
  }

  public setAudioChannelCount(count: number): void {
    if (Number.isFinite(count) && count > 0) this.numChannels = Math.max(1, Math.floor(count));
  }

  public setRecognitionLanguage(key: string): void {
    this.languageKey = key || 'chinese';
  }

  public setCredentials(_path: string): void {}

  public start(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.timer = setInterval(() => void this.flushAndUpload(), SAFETY_NET_MS);
  }

  public stop(): void {
    if (!this.isActive) return;
    void this.flushAndUpload(true);
    this.isActive = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public write(chunk: Buffer): void {
    if (!this.isActive || !chunk?.length) return;
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
  }

  public notifySpeechEnded(): void {
    if (this.isActive) void this.flushAndUpload();
  }

  public finalize(): void {
    if (this.isActive) void this.flushAndUpload();
  }

  private async flushAndUpload(allowAfterStop = false): Promise<void> {
    if (!this.isActive && !allowAfterStop) return;
    if (this.bufferedBytes < MIN_BUFFER_BYTES || this.chunks.length === 0) return;
    if (this.isUploading) {
      this.flushPending = true;
      return;
    }

    const raw = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bufferedBytes = 0;
    if (this.isSilent(raw)) return;

    const pcm16k = this.to16kMono(raw);
    const wav = this.addWavHeader(pcm16k, TARGET_RATE, 1);
    this.isUploading = true;

    try {
      const form = new FormData();
      form.append('file', wav, { filename: 'audio.wav', contentType: 'audio/wav' });
      form.append('model', configuredModel());

      const language = this.languageKey && this.languageKey !== 'auto'
        ? RECOGNITION_LANGUAGES[this.languageKey]?.iso639
        : undefined;
      if (language && language !== 'auto') form.append('language', language);

      const response = await axios.post(this.endpoint, form, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...form.getHeaders(),
        },
        timeout: 30_000,
        maxBodyLength: 30 * 1024 * 1024,
      });

      const text = typeof response.data === 'string'
        ? response.data
        : response.data?.text;
      if (typeof text === 'string' && text.trim()) {
        this.emit('transcript', {
          text: text.trim(),
          isFinal: true,
          confidence: 1,
        });
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isUploading = false;
      if (this.flushPending) {
        this.flushPending = false;
        void this.flushAndUpload(allowAfterStop);
      }
    }
  }

  private to16kMono(raw: Buffer): Buffer {
    const samples = Math.floor(raw.length / 2);
    const input = new Int16Array(samples);
    for (let i = 0; i < samples; i++) input[i] = raw.readInt16LE(i * 2);

    const monoLength = this.numChannels > 1
      ? Math.floor(input.length / this.numChannels)
      : input.length;
    const mono = new Int16Array(monoLength);

    if (this.numChannels > 1) {
      for (let i = 0; i < monoLength; i++) {
        let sum = 0;
        for (let c = 0; c < this.numChannels; c++) sum += input[i * this.numChannels + c] || 0;
        mono[i] = Math.round(sum / this.numChannels);
      }
    } else {
      mono.set(input);
    }

    if (this.inputSampleRate === TARGET_RATE) return Buffer.from(mono.buffer);
    const factor = this.inputSampleRate / TARGET_RATE;
    const outLength = Math.max(0, Math.floor(mono.length / factor));
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) out[i] = mono[Math.min(mono.length - 1, Math.floor(i * factor))] || 0;
    return Buffer.from(out.buffer);
  }

  private isSilent(raw: Buffer): boolean {
    let sum = 0;
    let count = 0;
    for (let i = 0; i + 1 < raw.length; i += 40) {
      const sample = raw.readInt16LE(i);
      sum += sample * sample;
      count++;
    }
    return count === 0 || Math.sqrt(sum / count) < SILENCE_RMS_THRESHOLD;
  }

  private addWavHeader(samples: Buffer, sampleRate: number, channels: number): Buffer {
    const out = Buffer.alloc(44 + samples.length);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + samples.length, 4);
    out.write('WAVE', 8);
    out.write('fmt ', 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(channels, 22);
    out.writeUInt32LE(sampleRate, 24);
    out.writeUInt32LE(sampleRate * channels * 2, 28);
    out.writeUInt16LE(channels * 2, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36);
    out.writeUInt32LE(samples.length, 40);
    samples.copy(out, 44);
    return out;
  }
}
