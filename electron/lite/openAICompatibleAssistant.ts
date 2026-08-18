import fs from 'node:fs';
import path from 'node:path';
import type { AppState } from '../main';
import { CredentialsManager } from '../services/CredentialsManager';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

type AssistantConfig = {
  baseURL: string;
  endpoint: string;
  apiKey?: string;
  model: string;
};

type StreamDiagnostics = {
  sawReasoning: boolean;
};

const LIVE_TTFC_BUDGET_MS = 7_000;

function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

export function resolveLiteAssistantEndpoint(baseURL: string): string {
  const raw = (baseURL || '').trim();
  if (!raw) throw new Error('Assistant Base URL is not configured.');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Assistant Base URL must use http:// or https://.');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) {
    // Already a complete endpoint.
  } else {
    pathname = `${pathname || '/v1'}/chat/completions`;
  }
  url.pathname = pathname;
  url.hash = '';
  return url.toString();
}

function isDashScopeHybridThinkingModel(config: AssistantConfig): boolean {
  try {
    const host = new URL(config.endpoint).hostname.toLowerCase();
    const isDashScope = host.endsWith('aliyuncs.com') && (
      host.includes('dashscope') || host.includes('.maas.')
    );
    return isDashScope && /^qwen3(?:[.\-]|$)/i.test(config.model);
  } catch {
    return false;
  }
}

function isOpenAIStyleReasoningModel(model: string): boolean {
  // This intentionally matches compatible aliases such as gpt-5.6-terra.
  // The user's gateway can still choose how it maps the field upstream.
  return /^(?:gpt-5(?:[.\-]|$)|o1(?:[.\-]|$)|o3(?:[.\-]|$)|o4(?:[.\-]|$))/i.test(model.trim());
}

function reasoningTuning(config: AssistantConfig): {
  fields: Record<string, unknown>;
  label: string;
} {
  if (isDashScopeHybridThinkingModel(config)) {
    // DashScope Qwen hybrid thinking: disable hidden reasoning for the live
    // meeting path so final answer content starts well inside the 7s TTFC cap.
    return { fields: { enable_thinking: false }, label: 'Qwen thinking off' };
  }
  if (isOpenAIStyleReasoningModel(config.model)) {
    // GPT-5/o-series compatible gateways commonly accept reasoning_effort.
    // Low is the best default for a live copilot: the application values time
    // to first FINAL content more than hidden chain-of-thought depth.
    return { fields: { reasoning_effort: 'low' }, label: 'reasoning_effort=low' };
  }
  // Do not send vendor-specific knobs to arbitrary compatible endpoints.
  return { fields: {}, label: 'compatibility default' };
}

function requestHeaders(config: AssistantConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey?.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  return headers;
}

function requestBody(
  config: AssistantConfig,
  messages: ChatMessage[],
  opts: { stream: boolean; maxTokens: number },
): Record<string, unknown> {
  const tuning = reasoningTuning(config);
  return {
    model: config.model,
    messages,
    stream: opts.stream,
    max_tokens: opts.maxTokens,
    ...tuning.fields,
  };
}

function currentConfig(cm: CredentialsManager, modelId?: string): AssistantConfig {
  const baseURL = (cm.getLitellmBaseURL() || '').trim();
  const persisted = (modelId || cm.getDefaultModel() || '').trim();
  const model = persisted.startsWith('litellm/') ? persisted.slice('litellm/'.length) : persisted;
  if (!model) throw new Error('Assistant model is not configured.');
  return {
    baseURL,
    endpoint: resolveLiteAssistantEndpoint(baseURL),
    apiKey: cm.getLitellmApiKey(),
    model,
  };
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `${response.status} ${response.statusText}`.trim();
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (message) return `${response.status}: ${String(message).slice(0, 700)}`;
  } catch {
    // Fall through to the bounded raw response.
  }
  return `${response.status}: ${text.slice(0, 700)}`;
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function textFromNonStreamingResponse(json: any): string {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('');
  }
  return '';
}

async function buildMessages(
  userMessage: string,
  systemPrompt?: string,
  imagePaths?: string[],
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

  if (!imagePaths?.length) {
    messages.push({ role: 'user', content: userMessage });
    return messages;
  }

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: userMessage }];
  for (const imagePath of imagePaths) {
    if (!fs.existsSync(imagePath)) continue;
    const b64 = (await fs.promises.readFile(imagePath)).toString('base64');
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mimeForFile(imagePath)};base64,${b64}` },
    });
  }
  messages.push({ role: 'user', content });
  return messages;
}

export async function completeLiteAssistant(
  cm: CredentialsManager,
  args: {
    modelId?: string;
    userMessage: string;
    systemPrompt?: string;
    imagePaths?: string[];
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ text: string; endpoint: string; model: string }> {
  const config = currentConfig(cm, args.modelId);
  const messages = await buildMessages(args.userMessage, args.systemPrompt, args.imagePaths);
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: requestHeaders(config),
    body: JSON.stringify(requestBody(config, messages, {
      stream: false,
      maxTokens: Math.max(1, Math.floor(args.maxTokens || 8192)),
    })),
    signal: combinedSignal(args.signal, args.timeoutMs || 60_000),
  });
  if (!response.ok) throw new Error(await readErrorBody(response));
  const json = await response.json();
  const text = textFromNonStreamingResponse(json);
  if (!text.trim()) {
    const reasoning = json?.choices?.[0]?.message?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      throw new Error('Provider returned reasoning_content but no final content. Disable thinking for interactive use.');
    }
    throw new Error('Provider returned an empty Assistant response.');
  }
  return { text, endpoint: config.endpoint, model: config.model };
}

export async function* streamLiteAssistant(
  cm: CredentialsManager,
  args: {
    modelId?: string;
    userMessage: string;
    systemPrompt?: string;
    imagePaths?: string[];
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    diagnostics?: StreamDiagnostics;
  },
): AsyncGenerator<string, void, unknown> {
  const config = currentConfig(cm, args.modelId);
  const messages = await buildMessages(args.userMessage, args.systemPrompt, args.imagePaths);
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: requestHeaders(config),
    body: JSON.stringify(requestBody(config, messages, {
      stream: true,
      maxTokens: Math.max(1, Math.floor(args.maxTokens || 8192)),
    })),
    signal: combinedSignal(args.signal, args.timeoutMs || 60_000),
  });
  if (!response.ok) throw new Error(await readErrorBody(response));
  if (!response.body) throw new Error('Assistant stream returned no response body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let yielded = false;
  let sawReasoning = false;

  const consumeLine = (line: string): string | null => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    try {
      const json = JSON.parse(payload);
      const delta = json?.choices?.[0]?.delta;
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
        sawReasoning = true;
        if (args.diagnostics) args.diagnostics.sawReasoning = true;
      }
      const content = delta?.content;
      return typeof content === 'string' && content ? content : null;
    } catch {
      return null;
    }
  };

  try {
    while (true) {
      if (args.signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const content = consumeLine(line);
        if (content) {
          yielded = true;
          yield content;
        }
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split('\n')) {
      const content = consumeLine(line);
      if (content) {
        yielded = true;
        yield content;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }

  if (!yielded) {
    if (sawReasoning) {
      throw new Error('Assistant stream produced reasoning_content but no final content before closing.');
    }
    throw new Error('Assistant stream completed without answer text.');
  }
}

/**
 * Lite runtime patch.
 *
 * Upstream calls the generic LiteLLM/OpenAI SDK adapter for text, but its unified
 * vision fallback does not put the user-selected LiteLLM model in the candidate
 * chain and CredentialsManager does not count LiteLLM as a vision provider.
 * Patch only those flavor-specific seams at runtime instead of forking the large
 * upstream LLMHelper implementation.
 */
export function installLiteAssistantRuntime(appState: AppState): void {
  const cm = CredentialsManager.getInstance();
  const llm = appState.processingHelper.getLLMHelper() as any;
  if (!llm || llm.__nativelyLiteAssistantPatched) return;
  llm.__nativelyLiteAssistantPatched = true;

  const originalAnyVisionProviderConfigured = cm.anyVisionProviderConfigured.bind(cm);
  (cm as any).anyVisionProviderConfigured = () => {
    const configuredLiteModel = cm.getDefaultModel().startsWith('litellm/');
    if (configuredLiteModel && !!cm.getLitellmBaseURL()?.trim()) return true;
    return originalAnyVisionProviderConfigured();
  };

  llm.streamWithLiteLLM = async function* (
    userMessage: string,
    systemPrompt?: string,
    imagePaths?: string[],
    abortSignal?: AbortSignal,
  ) {
    if (this.isLocalOnlyMode) throw new Error('Cloud providers disabled in local-only mode');
    this.assertOutboundScopes?.('litellm', userMessage, imagePaths);
    await this.rateLimiters?.litellm?.acquire?.();
    const modelId = String(this.getCurrentModelId?.() || this.currentModelId || cm.getDefaultModel());
    const rawModel = modelId.startsWith('litellm/') ? modelId.slice('litellm/'.length) : modelId;
    const maxTokens = typeof this.resolveLitellmMaxTokens === 'function'
      ? await this.resolveLitellmMaxTokens(rawModel)
      : (cm.getLitellmMaxTokens() || 8192);
    yield* streamLiteAssistant(cm, {
      modelId,
      userMessage,
      systemPrompt,
      imagePaths,
      maxTokens,
      signal: abortSignal,
      timeoutMs: 60_000,
    });
  };

  llm.generateWithLiteLLM = async function (
    userMessage: string,
    systemPrompt?: string,
    imagePaths?: string[],
  ) {
    if (this.isLocalOnlyMode) throw new Error('Cloud providers disabled in local-only mode');
    this.assertOutboundScopes?.('litellm', userMessage, imagePaths);
    await this.rateLimiters?.litellm?.acquire?.();
    const modelId = String(this.getCurrentModelId?.() || this.currentModelId || cm.getDefaultModel());
    const rawModel = modelId.startsWith('litellm/') ? modelId.slice('litellm/'.length) : modelId;
    const maxTokens = typeof this.resolveLitellmMaxTokens === 'function'
      ? await this.resolveLitellmMaxTokens(rawModel)
      : (cm.getLitellmMaxTokens() || 8192);
    const result = await completeLiteAssistant(cm, {
      modelId,
      userMessage,
      systemPrompt,
      imagePaths,
      maxTokens,
      timeoutMs: 60_000,
    });
    return result.text;
  };

  const originalVisionFallback = typeof llm.streamVisionWithFallback === 'function'
    ? llm.streamVisionWithFallback.bind(llm)
    : null;

  llm.streamVisionWithFallback = async function* (
    req: { userContent: string; imagePaths: string[]; systemPrompt: string },
    abortSignal?: AbortSignal,
  ) {
    const currentModelId = String(this.getCurrentModelId?.() || this.currentModelId || cm.getDefaultModel());
    if (currentModelId.startsWith('litellm/') && cm.getLitellmBaseURL()?.trim()) {
      let emitted = false;
      try {
        for await (const chunk of this.streamWithLiteLLM(
          req.userContent,
          req.systemPrompt,
          req.imagePaths,
          abortSignal,
        )) {
          emitted = true;
          yield chunk;
        }
        if (emitted) return;
      } catch (error: any) {
        if (emitted) return;
        console.warn('[LiteCN] Selected Assistant vision request failed; falling back:', error?.message || error);
      }
    }

    if (!originalVisionFallback) {
      throw new Error('No vision fallback implementation is available.');
    }
    yield* originalVisionFallback(req, abortSignal);
  };
}

export async function testLiteAssistantConnection(): Promise<{
  success: boolean;
  endpoint?: string;
  model?: string;
  latencyMs?: number;
  ttfcMs?: number;
  withinLiveBudget?: boolean;
  sawReasoning?: boolean;
  reasoningMode?: string;
  preview?: string;
  error?: string;
}> {
  const cm = CredentialsManager.getInstance();
  const config = currentConfig(cm);
  const tuning = reasoningTuning(config);
  const diagnostics: StreamDiagnostics = { sawReasoning: false };
  const started = Date.now();
  let firstContentAt = 0;
  let preview = '';

  try {
    // Probe the same SSE path the meeting UI actually uses. We deliberately do
    // NOT stop at HTTP 200 or at the first role/reasoning chunk: success means
    // the gateway produced real delta.content, which is exactly what Natively's
    // 7s first-useful deadline waits for.
    for await (const chunk of streamLiteAssistant(cm, {
      userMessage: 'Reply with exactly: OK',
      systemPrompt: 'You are a connectivity probe. Follow the user instruction exactly.',
      maxTokens: 32,
      timeoutMs: 20_000,
      diagnostics,
    })) {
      if (!firstContentAt) firstContentAt = Date.now();
      preview += chunk;
      if (preview.trim().length >= 2) break;
    }

    if (!firstContentAt) throw new Error('Stream ended before any final answer content was received.');
    const ttfcMs = firstContentAt - started;
    const withinLiveBudget = ttfcMs <= LIVE_TTFC_BUDGET_MS;
    const budgetText = withinLiveBudget
      ? `TTFC ${ttfcMs} ms / 7s live budget OK`
      : `TTFC ${ttfcMs} ms > 7s live budget; meeting requests may fall back`;
    const reasoningText = diagnostics.sawReasoning ? 'reasoning_content observed' : 'no reasoning_content before answer';

    return {
      success: true,
      endpoint: config.endpoint,
      model: config.model,
      latencyMs: ttfcMs,
      ttfcMs,
      withinLiveBudget,
      sawReasoning: diagnostics.sawReasoning,
      reasoningMode: tuning.label,
      preview: `${budgetText} · stream=true · ${tuning.label} · ${reasoningText} · reply=${preview.trim().slice(0, 80)}`,
    };
  } catch (error: any) {
    return {
      success: false,
      endpoint: config.endpoint,
      model: config.model,
      latencyMs: Date.now() - started,
      sawReasoning: diagnostics.sawReasoning,
      reasoningMode: tuning.label,
      error: error?.message || String(error),
    };
  }
}
