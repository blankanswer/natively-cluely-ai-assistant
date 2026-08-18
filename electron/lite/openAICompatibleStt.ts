import axios from 'axios';
import FormData from 'form-data';

export const DEFAULT_OPENAI_COMPATIBLE_STT_BASE = 'https://api.openai.com';

export interface OpenAICompatibleTranscriptionRequest {
  apiKey: string;
  endpointOrBaseUrl?: string;
  model: string;
  wav: Buffer;
  language?: string;
  timeoutMs?: number;
}

export interface OpenAICompatibleTranscriptionResult {
  text: string;
  endpoint: string;
  model: string;
}

/**
 * Resolve either a base URL or a complete OpenAI-compatible transcription URL.
 *
 * Supported input forms:
 *   https://host.example
 *   https://host.example/v1
 *   https://host.example/v1/
 *   https://host.example/v1/audio/transcriptions
 *
 * The complete `/audio/transcriptions` form is deliberately idempotent. This is
 * important for gateway vendors (SiliconFlow, LiteLLM, Speaches, etc.) because
 * blindly appending `/v1/audio/transcriptions` to a complete URL produces the
 * exact 404 that the Lite settings screen used to show.
 */
export function resolveOpenAICompatibleTranscriptionEndpoint(value?: string): string {
  const raw = String(value || DEFAULT_OPENAI_COMPATIBLE_STT_BASE).trim();
  const input = raw || DEFAULT_OPENAI_COMPATIBLE_STT_BASE;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('STT Endpoint 必须是完整的 http:// 或 https:// URL。');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('STT Endpoint 仅支持 http:// 或 https://。');
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(pathname)) {
    // Already complete: keep it exactly once.
  } else if (/\/v\d+$/i.test(pathname)) {
    pathname += '/audio/transcriptions';
  } else if (!pathname || pathname === '/') {
    pathname = '/v1/audio/transcriptions';
  } else {
    pathname += '/v1/audio/transcriptions';
  }

  url.pathname = pathname;
  // URL fragments are never part of an HTTP request target and are usually a
  // copy/paste mistake in an API endpoint, so drop them deterministically.
  url.hash = '';
  return url.toString();
}

/**
 * One request implementation shared by live Lite STT and the Settings
 * "测试连接" button. Keeping them on the same code path prevents endpoint/model
 * drift: if the probe succeeds, the meeting transcription uses the same URL,
 * multipart shape and model field.
 */
export async function transcribeOpenAICompatibleWav(
  request: OpenAICompatibleTranscriptionRequest,
): Promise<OpenAICompatibleTranscriptionResult> {
  const apiKey = String(request.apiKey || '').trim();
  const model = String(request.model || '').trim();
  if (!apiKey) throw new Error('STT API Key 不能为空。');
  if (!model) throw new Error('STT Model 不能为空。');
  if (!Buffer.isBuffer(request.wav) || request.wav.length === 0) {
    throw new Error('STT 测试音频为空。');
  }

  const endpoint = resolveOpenAICompatibleTranscriptionEndpoint(request.endpointOrBaseUrl);
  const form = new FormData();
  form.append('file', request.wav, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', model);
  if (request.language?.trim()) form.append('language', request.language.trim());

  const response = await axios.post(endpoint, form, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    timeout: request.timeoutMs ?? 30_000,
    maxBodyLength: 30 * 1024 * 1024,
  });

  const text = typeof response.data === 'string'
    ? response.data
    : response.data?.text;

  return {
    text: typeof text === 'string' ? text.trim() : '',
    endpoint,
    model,
  };
}

function errorBodyMessage(data: any): string | null {
  if (typeof data === 'string' && data.trim()) return data.trim();
  const candidates = [
    data?.error?.message,
    data?.error?.detail,
    typeof data?.error === 'string' ? data.error : undefined,
    data?.message,
    data?.detail,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** Friendly, non-secret diagnostics for both probe and live STT failures. */
export function describeOpenAICompatibleSttError(
  error: any,
  endpointOrBaseUrl?: string,
  model?: string,
): string {
  let endpoint = '';
  try {
    endpoint = resolveOpenAICompatibleTranscriptionEndpoint(endpointOrBaseUrl);
  } catch {
    endpoint = String(endpointOrBaseUrl || '').trim();
  }

  const status = error?.response?.status;
  const bodyMessage = errorBodyMessage(error?.response?.data);
  const lowLevel = typeof error?.message === 'string' ? error.message : String(error || 'Unknown error');
  const reason = bodyMessage || lowLevel || 'Unknown error';
  const statusLabel = status ? `HTTP ${status}` : '网络/请求错误';
  const parts = [`STT 测试失败 (${statusLabel})`];
  if (endpoint) parts.push(`URL: ${endpoint}`);
  if (model?.trim()) parts.push(`Model: ${model.trim()}`);
  parts.push(reason);
  return parts.join(' · ');
}
