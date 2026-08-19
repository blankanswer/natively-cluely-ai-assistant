export type LiteConversationMessageLike = {
  role: string;
  text: string;
  isQuickActionLabel?: boolean;
  hasScreenshot?: boolean;
  screenshotPath?: string;
};

const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 18_000;
const MAX_SINGLE_TURN_CHARS = 2_500;
const SCREENSHOT_SCAN_TURNS = 12;
const MAX_CARRIED_SCREENSHOTS = 2;

export const LITE_SCREEN_AUTO_LABEL = '分析当前屏幕';

export const LITE_SCREEN_AUTO_PROMPT = `You are a screen-aware desktop assistant. Infer the task the user is most likely trying to accomplish from the screenshot, the recent conversation, and any visible app context. Do not merely describe the screenshot unless description is actually the task.

Act on the likely intent:
- If a coding problem, algorithm exercise, IDE, or code editor is visible, solve the problem and provide usable code in the visible/requested language and input-output format. Include the core algorithm and complexity when useful.
- If an error, stack trace, failing test, or broken UI is visible, diagnose the cause and propose the concrete fix.
- If an interview/question prompt is visible, answer it directly in a form the user can use.
- If a document, dashboard, spreadsheet, or web page is visible, answer the likely question or help complete the visible task.
- If the task is genuinely ambiguous, state the most likely interpretation briefly and ask one targeted clarification.

Treat the screenshot as task context, not as an object-identification exercise.`;

type HistoryPayloadItem = {
  role: 'user' | 'assistant';
  content: string;
};

function normalizedHistoryItem(message: LiteConversationMessageLike): HistoryPayloadItem | null {
  if (message.isQuickActionLabel || typeof message.text !== 'string') return null;
  const raw = message.text.trim();
  if (!raw) return null;
  const bounded = raw.length > MAX_SINGLE_TURN_CHARS
    ? `${raw.slice(0, MAX_SINGLE_TURN_CHARS)}\n[older turn truncated]`
    : raw;
  return {
    role: message.role === 'user' || message.role === 'interviewer' ? 'user' : 'assistant',
    content:
      message.role === 'interviewer'
        ? `Interviewer: ${bounded}`
        : message.hasScreenshot
          ? `[Screenshot attached] ${bounded}`
          : bounded,
  };
}

function historyPayload(items: LiteConversationMessageLike[]): HistoryPayloadItem[] {
  const out: HistoryPayloadItem[] = [];
  let usedChars = 0;

  for (let i = items.length - 1; i >= 0 && out.length < MAX_HISTORY_TURNS; i -= 1) {
    const item = normalizedHistoryItem(items[i]);
    if (!item) continue;
    const cost = item.content.length + 32;
    if (out.length > 0 && usedChars + cost > MAX_HISTORY_CHARS) break;
    usedChars += cost;
    out.push(item);
  }

  return out.reverse();
}

/**
 * Builds one canonical conversation block for every Lite input path.
 *
 * Upstream may wrap this block in its own CONTEXT envelope. The Lite Assistant
 * adapter extracts the JSON back into genuine Chat Completions messages before
 * the current user turn. Keeping the JSON inside a tagged block also leaves it
 * understandable to an emergency non-Lite provider fallback.
 */
export function buildLiteConversationContext(items: LiteConversationMessageLike[]): string {
  const payload = historyPayload(items);
  if (payload.length === 0) return '';

  // Escape '<' so user text cannot synthesize our closing tag. JSON.parse
  // transparently restores \u003c to '<'. This is much smaller than
  // encodeURIComponent for Chinese text and stays under the 25k DOM-context cap.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<natively_lite_history>\n${json}\n</natively_lite_history>`;
}

export function mergeLiteConversationContext(
  primary?: string | null,
  secondary?: string | null,
): string | undefined {
  const parts = [primary, secondary]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function promptRefersToVisualContext(text: string): boolean {
  return /(截图|截屏|图片|图里|图中|刚才|刚刚|上面|上一|之前|这个题|这道题|代码|报错|界面|screen|screenshot|image|picture|previous|above|this\s+(?:problem|code|error|screen))/i.test(
    text || '',
  );
}

function promptRefersToPreviousVisualContext(text: string): boolean {
  return /(刚才|刚刚|上一|之前|前一|比较|对比|previous|earlier|above|last\s+(?:screen|screenshot|image|picture)|compare)/i.test(
    text || '',
  );
}

function recentScreenshotPaths(items: LiteConversationMessageLike[]): Array<{ path: string; index: number }> {
  const out: Array<{ path: string; index: number }> = [];
  const seen = new Set<string>();
  const start = Math.max(0, items.length - SCREENSHOT_SCAN_TURNS);
  for (let i = items.length - 1; i >= start; i -= 1) {
    const path = items[i]?.screenshotPath?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, index: i });
    if (out.length >= MAX_CARRIED_SCREENSHOTS) break;
  }
  return out;
}

/**
 * Keeps visual follow-ups multimodal without resending the whole meeting's
 * screenshots. A fresh screenshot stands on its own unless the prompt asks to
 * compare with an earlier image. With no current image, the last screenshot is
 * carried for a short follow-up window or an explicit visual reference.
 */
export function mergeLiteScreenshotPaths(
  current: string[] | undefined,
  items: LiteConversationMessageLike[],
  promptText = '',
): string[] | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const candidate of current || []) {
    const path = candidate?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    merged.push(path);
  }

  const recent = recentScreenshotPaths(items);
  const mostRecent = recent[0];
  const turnsSinceMostRecent = mostRecent
    ? Math.max(0, items.length - 1 - mostRecent.index)
    : Number.POSITIVE_INFINITY;

  const shouldCarryHistory = merged.length > 0
    ? promptRefersToPreviousVisualContext(promptText)
    : turnsSinceMostRecent <= 4 || promptRefersToVisualContext(promptText);

  if (shouldCarryHistory) {
    for (const { path } of recent) {
      if (seen.has(path)) continue;
      seen.add(path);
      merged.push(path);
      if (merged.length >= 3) break;
    }
  }

  return merged.length > 0 ? merged : undefined;
}
