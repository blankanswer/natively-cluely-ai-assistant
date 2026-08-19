export type LiteHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const HISTORY_RE = /<natively_lite_history>\s*([\s\S]*?)\s*<\/natively_lite_history>/g;

/**
 * Pull the renderer's canonical Lite conversation payload out of the composed
 * upstream USER content. LLMHelper wraps caller context as
 * `CONTEXT: ... USER QUESTION: ...`, so the marker reaches provider adapters in
 * userMessage rather than systemPrompt. Recover it here and reconstruct real
 * Chat Completions history messages while retaining all other caller context.
 */
export function extractLiteConversationFromPrompt(prompt: string): {
  currentUserText: string;
  history: LiteHistoryMessage[];
} {
  if (!prompt) return { currentUserText: prompt, history: [] };

  let lastPayload = '';
  let clean = prompt.replace(HISTORY_RE, (_match, json: string) => {
    lastPayload = json || lastPayload;
    return '';
  });

  // If the removed marker was the only CONTEXT payload, avoid leaving a noisy
  // empty `CONTEXT:` header before `USER QUESTION:`. Other transcript/DOM
  // context remains untouched.
  clean = clean
    .replace(/CONTEXT:\s*\n\s*USER QUESTION:/g, 'USER QUESTION:')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!lastPayload) return { currentUserText: clean || prompt, history: [] };

  try {
    const parsed = JSON.parse(lastPayload);
    if (!Array.isArray(parsed)) return { currentUserText: clean || prompt, history: [] };
    const history: LiteHistoryMessage[] = parsed
      .filter((item: any) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
      .map((item: any) => ({ role: item.role, content: item.content.trim() }))
      .filter((item: LiteHistoryMessage) => item.content.length > 0)
      .slice(-20);
    return { currentUserText: clean || prompt, history };
  } catch (error) {
    console.warn('[LiteCN] Failed to decode structured conversation history:', error);
    return { currentUserText: clean || prompt, history: [] };
  }
}
