import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { version } from './package.json';

process.env.VITE_APP_VERSION = version;

const root = path.resolve(__dirname);

/**
 * Keep the upstream React source reusable while making the Lite renderer a
 * genuinely product-light build. These are build-time source transforms, so
 * the Windows/macOS Lite packages both omit the commercial/onboarding surfaces
 * without carrying a second fork of App.tsx/Launcher.tsx.
 */
function liteProductSurfaceStripper() {
  const appPath = path.join(root, 'src', 'App.tsx');
  const launcherPath = path.join(root, 'src', 'components', 'Launcher.tsx');

  return {
    name: 'lite-cn-product-surface-stripper',
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
          if (!next.includes(from)) {
            throw new Error(`[Lite renderer] App.tsx surface marker drifted: ${from}`);
          }
          next = next.replace(from, to);
        }
        return { code: next, map: null };
      }

      if (path.resolve(cleanId) === path.resolve(launcherPath)) {
        let next = code;

        // No What's New / upstream release marketing pill in Lite.
        const whatsNew = '{launchCount < 10 && (';
        if (!next.includes(whatsNew)) {
          throw new Error('[Lite renderer] Launcher Whats New marker drifted');
        }
        next = next.replace(whatsNew, '{false && launchCount < 10 && (');

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

      return null;
    },
  };
}

export default defineConfig({
  plugins: [liteProductSurfaceStripper(), react()],
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
