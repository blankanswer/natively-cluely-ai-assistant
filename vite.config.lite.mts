import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { version } from './package.json';

process.env.VITE_APP_VERSION = version;

const root = path.resolve(__dirname);
const appPath = path.join(root, 'src', 'App.tsx');
const launcherPath = path.join(root, 'src', 'components', 'Launcher.tsx');
const nativelyInterfacePath = path.join(root, 'src', 'components', 'NativelyInterface.tsx');

function replaceRequired(source: string, from: string, to: string, label: string): string {
  if (!source.includes(from)) throw new Error(`[Lite renderer] ${label} marker drifted`);
  return source.replace(from, to);
}

/**
 * Keep the upstream React source reusable while making the Lite renderer a
 * genuinely product-light build. These are build-time source transforms, so
 * the Windows/macOS Lite packages both omit commercial/onboarding surfaces and
 * share one conversation model without maintaining a second NativelyInterface.
 */
function liteSourceTransforms() {
  return {
    name: 'lite-cn-source-transforms',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const cleanId = id.split('?')[0];

      if (path.resolve(cleanId) === path.resolve(appPath)) {
        let next = code;

        // Launcher-only upstream ecosystem surfaces. The meeting overlay and its
        // core audio/status UI remain untouched.
        const replacements: Array<[string, string]> = [
          [
            '{!isolateGlobalSurfaces && showHindsightBanner && (',
            '{false && !isolateGlobalSurfaces && showHindsightBanner && (',
          ],
          [
            '{!isolateGlobalSurfaces && <UpdateBanner />}',
            '{false && !isolateGlobalSurfaces && <UpdateBanner />}',
          ],
          [
            '{!isolateGlobalSurfaces && <NativelyQuotaBanner />}',
            '{false && !isolateGlobalSurfaces && <NativelyQuotaBanner />}',
          ],
          [
            '{!isolateOnboarding && (',
            '{false && !isolateOnboarding && (',
          ],
          [
            '{!isolateGlobalSurfaces && shouldMountDevReviewHost() && <ReviewPromptHost />}',
            '{false && !isolateGlobalSurfaces && shouldMountDevReviewHost() && <ReviewPromptHost />}',
          ],
          [
            '{!isolateGlobalSurfaces && (isLauncherWindow || isDefault) && activeTrial && (',
            '{false && !isolateGlobalSurfaces && (isLauncherWindow || isDefault) && activeTrial && (',
          ],
          [
            '{!isolateModals && (isLauncherWindow || isDefault) && showTrialExpiredModal && (',
            '{false && !isolateModals && (isLauncherWindow || isDefault) && showTrialExpiredModal && (',
          ],
          [
            "{!isolateModals && isLauncherMainView && !isSettingsOpen && (",
            "{false && !isolateModals && isLauncherMainView && !isSettingsOpen && (",
          ],
          [
            '{!isolateModals && isLauncherMainView && (',
            '{false && !isolateModals && isLauncherMainView && (',
          ],
          [
            '{!isolateModals && <PremiumUpgradeModal',
            '{false && !isolateModals && <PremiumUpgradeModal',
          ],
        ];

        for (const [from, to] of replacements) {
          next = replaceRequired(next, from, to, `App.tsx surface ${from}`);
        }
        return { code: next, map: null };
      }

      if (path.resolve(cleanId) === path.resolve(launcherPath)) {
        let next = code;

        // No What's New / upstream release marketing pill in Lite.
        const whatsNew = '{launchCount < 10 && (';
        next = replaceRequired(next, whatsNew, '{false && launchCount < 10 && (', 'Launcher Whats New');

        // Remove the entire FeatureSpotlight + Calendar promo row. This avoids
        // leaving a 198px empty placeholder, unlike simply stubbing the two
        // child components.
        const heroStart = '                                    {/* 2. Hero Section Cards */}';
        const heroEnd = '                                </div>\n                            </section>';
        const start = next.indexOf(heroStart);
        const end = next.indexOf(heroEnd, start);
        if (start < 0 || end < 0) {
          throw new Error('[Lite renderer] Launcher hero-card markers drifted');
        }
        next = next.slice(0, start) + next.slice(end);

        return { code: next, map: null };
      }

      if (path.resolve(cleanId) === path.resolve(nativelyInterfacePath)) {
        let next = code;

        // Lite-only conversation helpers. They keep typed input, STT Answer and
        // screenshot hotkeys on the same history and carry recent images for
        // visual follow-ups without forking the giant upstream component.
        const skillImport = "import type { SkillSummary } from '../types/electron';\n";
        const liteImport = `${skillImport}import {\n  buildLiteConversationContext,\n  LITE_SCREEN_AUTO_LABEL,\n  LITE_SCREEN_AUTO_PROMPT,\n  mergeLiteConversationContext,\n  mergeLiteScreenshotPaths,\n} from '../lite/conversation';\n`;
        next = replaceRequired(next, skillImport, liteImport, 'NativelyInterface Lite conversation import');

        next = replaceRequired(
          next,
          '  screenshotPreview?: string;\n',
          '  screenshotPreview?: string;\n  screenshotPath?: string;\n',
          'NativelyInterface screenshotPath field',
        );

        // Screenshot turns must remain in the canonical history. The old code
        // deliberately filtered them out, which made the very next "刚才那张图"
        // turn appear memoryless.
        const contextStart = 'const buildConversationContextFromMessages = (items: Message[]): string =>';
        const contextEndMarker = '\n\n// PERF: HighlightedCode renders a single fenced code block.';
        const contextStartIndex = next.indexOf(contextStart);
        const contextEndIndex = next.indexOf(contextEndMarker, contextStartIndex);
        if (contextStartIndex < 0 || contextEndIndex < 0) {
          throw new Error('[Lite renderer] conversation-context builder markers drifted');
        }
        next =
          next.slice(0, contextStartIndex) +
          'const buildConversationContextFromMessages = (items: Message[]): string =>\n  buildLiteConversationContext(items);' +
          next.slice(contextEndIndex);

        // Keep the on-disk screenshot path on the chat turn, not only its data
        // preview. That lets later typed/STT turns resend the recent image to a
        // multimodal model when the user says "that screenshot / this problem".
        let screenshotPathInsertions = 0;
        next = next.replace(
          /(^[ \t]*)screenshotPreview: currentAttachments\[0\]\.preview,\n/gm,
          (_match, indent: string) => {
            screenshotPathInsertions += 1;
            return `${indent}screenshotPreview: currentAttachments[0].preview,\n${indent}screenshotPath: currentAttachments[0].path,\n`;
          },
        );
        next = next.replace(
          /(^[ \t]*)screenshotPreview: currentAttachments\[0\]\?\.preview,\n/gm,
          (_match, indent: string) => {
            screenshotPathInsertions += 1;
            return `${indent}screenshotPreview: currentAttachments[0]?.preview,\n${indent}screenshotPath: currentAttachments[0]?.path,\n`;
          },
        );
        if (screenshotPathInsertions < 2) {
          throw new Error('[Lite renderer] screenshot preview/path markers drifted');
        }

        next = replaceRequired(
          next,
          "          text: 'What should I say about this?',\n",
          "          text: dynamicPromptInstruction === LITE_SCREEN_AUTO_PROMPT ? LITE_SCREEN_AUTO_LABEL : 'What should I say about this?',\n",
          'capture visible label',
        );

        // The global screen shortcut is a generic screen task, not the
        // interview-specific "what should I say" action.
        next = replaceRequired(
          next,
          '          handlersRef.current.handleWhatToSay();\n',
          '          handlersRef.current.handleWhatToSay(LITE_SCREEN_AUTO_PROMPT);\n',
          'capture-and-process handler',
        );

        // Feed the same recent message history into generateWhatToSay and keep
        // any DOM/page context alongside it instead of choosing one or the other.
        const whatToSayOptions = `      const options =\n        dynamicPromptInstruction || domContext\n          ? {\n              ...(dynamicPromptInstruction ? { promptInstruction: dynamicPromptInstruction } : {}),\n              ...(domContext ? { domContext } : {}),\n              ...(domContextEnvelope ? { domContextEnvelope } : {}),\n            }\n          : undefined;\n`;
        const whatToSayOptionsLite = `      const liteConversationContext = buildConversationContextFromMessages(messages);\n      const liteDomContext = mergeLiteConversationContext(liteConversationContext, domContext);\n      const options =\n        dynamicPromptInstruction || liteDomContext\n          ? {\n              ...(dynamicPromptInstruction ? { promptInstruction: dynamicPromptInstruction } : {}),\n              ...(liteDomContext ? { domContext: liteDomContext } : {}),\n              ...(domContextEnvelope ? { domContextEnvelope } : {}),\n            }\n          : undefined;\n`;
        next = replaceRequired(next, whatToSayOptions, whatToSayOptionsLite, 'what-to-say unified context');

        const generateWhatToSayCall = `      const result = await window.electronAPI.generateWhatToSay(\n        undefined,\n        currentAttachments.length > 0 ? currentAttachments.map((s) => s.path) : undefined,\n        options,\n      );\n`;
        const generateWhatToSayCallLite = `      const result = await window.electronAPI.generateWhatToSay(\n        undefined,\n        mergeLiteScreenshotPaths(\n          currentAttachments.map((s) => s.path),\n          messages,\n          dynamicPromptInstruction || LITE_SCREEN_AUTO_LABEL,\n        ),\n        options,\n      );\n`;
        next = replaceRequired(next, generateWhatToSayCall, generateWhatToSayCallLite, 'what-to-say multimodal history');

        // STT Answer previously replaced the third stream argument with its own
        // interview prompt, discarding the same messages history typed chat uses.
        const voiceCall = `          requestStartTimeRef.current = Date.now();\n          await window.electronAPI.streamGeminiChat(\n            question,\n            currentAttachments.length > 0 ? currentAttachments.map((s) => s.path) : undefined,\n            prompt,\n            { skipSystemPrompt: true },\n          );\n`;
        const voiceCallLite = `          const voiceConversationContext = buildConversationContextFromMessages(messages);\n          const voiceUnifiedContext = mergeLiteConversationContext(prompt, voiceConversationContext);\n          requestStartTimeRef.current = Date.now();\n          await window.electronAPI.streamGeminiChat(\n            question,\n            mergeLiteScreenshotPaths(currentAttachments.map((s) => s.path), messages, question),\n            voiceUnifiedContext,\n            { skipSystemPrompt: true },\n          );\n`;
        next = replaceRequired(next, voiceCall, voiceCallLite, 'STT Answer unified context');

        // Typed chat already used the message history; extend its image list with
        // the last screenshot for immediate "what about that image?" follow-ups.
        const typedCall = `      await window.electronAPI.streamGeminiChat(\n        userText || 'Analyze this screenshot',\n        currentAttachments.length > 0 ? currentAttachments.map((s) => s.path) : undefined,\n        conversationContextForSubmit, // Pass freshly-derived context so \"answer this\" works\n      );\n`;
        const typedCallLite = `      await window.electronAPI.streamGeminiChat(\n        userText || 'Analyze this screenshot',\n        mergeLiteScreenshotPaths(currentAttachments.map((s) => s.path), messages, userText),\n        conversationContextForSubmit,\n      );\n`;
        next = replaceRequired(next, typedCall, typedCallLite, 'typed chat visual history');

        // While collapsed the native overlay intentionally ignores mouse events.
        // Electron's {forward:true} still delivers mousemove into the renderer;
        // without this guard the normal transparent-margin hover gate can see the
        // forwarded pointer cross the old (now invisible) panel rect and turn native
        // hit-testing back ON, recreating the dead-click rectangle after Hide.
        next = replaceRequired(
          next,
          `    const onMouseMove = (e: MouseEvent) => {
      const margin =`,
          `    const onMouseMove = (e: MouseEvent) => {
      if (!isExpandedRef.current) return;
      const margin =`,
          'collapsed overlay hover guard',
        );

        // The state already carries a preview; render it instead of throwing the
        // information away and showing only the words "Screenshot attached".
        const screenshotHeaderStart = `            {msg.role === 'user' && msg.hasScreenshot && (\n`;
        const screenshotHeaderEnd = `            {/* Correction header:`;
        const screenshotHeaderStartIndex = next.indexOf(screenshotHeaderStart);
        const screenshotHeaderEndIndex = next.indexOf(screenshotHeaderEnd, screenshotHeaderStartIndex);
        if (screenshotHeaderStartIndex < 0 || screenshotHeaderEndIndex < 0) {
          throw new Error('[Lite renderer] screenshot thumbnail renderer markers drifted');
        }
        const screenshotHeaderLite = `            {msg.role === 'user' && msg.hasScreenshot && (\n              <div\n                className={\`mb-2 overflow-hidden rounded-lg border \${isLightTheme ? 'border-black/10 bg-black/[0.02]' : 'border-white/10 bg-white/[0.03]'}\`}\n              >\n                {msg.screenshotPreview ? (\n                  <img\n                    src={msg.screenshotPreview}\n                    alt={t('Screenshot attached')}\n                    className="block max-h-44 w-auto max-w-full object-contain"\n                  />\n                ) : (\n                  <div className="flex items-center gap-1 px-2 py-1.5 text-[10px] opacity-70">\n                    <Image className="w-2.5 h-2.5" />\n                    <span>{t('Screenshot attached')}</span>\n                  </div>\n                )}\n              </div>\n            )}\n`;
        next = next.slice(0, screenshotHeaderStartIndex) + screenshotHeaderLite + next.slice(screenshotHeaderEndIndex);

        return { code: next, map: null };
      }

      return null;
    },
  };
}

export default defineConfig({
  plugins: [liteSourceTransforms(), react()],
  base: './',
  define: {
    'import.meta.env.VITE_LITE_CN': JSON.stringify('1'),
  },
  resolve: {
    alias: [
      // Replace the very large commercial/general settings surface with the
      // small BYOK-focused Lite panel without editing upstream App.tsx.
      {
        find: /^\.\/components\/SettingsOverlay$/,
        replacement: path.join(root, 'src/lite/LiteSettingsOverlay.tsx'),
      },
      // Lite settings uses a purpose-built Skills panel: built-ins are editable
      // in-app, while custom SKILL.md files stay externally authored/uploaded.
      {
        find: /^\.\.\/components\/settings\/SkillsSettings$/,
        replacement: path.join(root, 'src/lite/LiteSkillsSettings.tsx'),
      },
      { find: '@', replacement: path.join(root, 'src') },
      { find: '@hooks', replacement: path.join(root, 'src/hooks') },
      { find: '@config', replacement: path.join(root, 'src/config') },
    ],
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: path.join(root, 'index.html'),
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'scheduler'],
          'animation-vendor': ['framer-motion'],
          'icon-vendor': ['lucide-react', 'react-icons'],
          'radix-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-toast'],
          'markdown-vendor': [
            'react-markdown',
            'remark-gfm',
            'remark-math',
            'rehype-katex',
            'katex',
            'react-syntax-highlighter',
            'marked',
          ],
          'data-vendor': ['@tanstack/react-query', 'axios'],
        },
      },
    },
  },
});
