import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { version } from './package.json';

process.env.VITE_APP_VERSION = version;

const root = path.resolve(__dirname);

export default defineConfig({
  plugins: [react()],
  base: './',
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
