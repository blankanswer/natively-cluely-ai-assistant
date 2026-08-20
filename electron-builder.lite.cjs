/**
 * Sottura packaging profile.
 *
 * This remains intentionally independent from the upstream release/signing flow:
 * - keeps native microphone/system-audio capture
 * - does not bundle local model payloads
 * - does not emit updater metadata
 * - builds only the runner's current architecture in CI
 */
const base = require('./package.json').build;

const isModelsResource = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  return typeof entry.from === 'string' && /(^|\/)resources\/models\/?$/.test(entry.from.replace(/\\/g, '/'));
};

const currentArch = process.arch === 'arm64' ? 'arm64' : 'x64';

module.exports = {
  ...base,
  // Sottura has its own application identity. Do not reuse the upstream bundle
  // id: macOS TCC / LaunchServices key permission state off bundle identity and
  // signing requirement, while Windows also benefits from a clean install id.
  appId: 'com.blankanswer.sottura',
  productName: 'Sottura',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  generateUpdatesFilesForAllChannels: false,
  publish: null,
  extraMetadata: {
    ...(base.extraMetadata || {}),
    nativelySigned: false,
    sotturaBuild: true,
  },
  extraResources: (base.extraResources || []).filter((entry) => !isModelsResource(entry)),
  asarUnpack: (base.asarUnpack || []).filter((pattern) => {
    const p = String(pattern);
    return !(
      p.includes('whisperWorker.js') ||
      p.includes('intentClassifierWorker.js') ||
      p.includes('localEmbeddingWorker.js') ||
      p.includes('localRerankerWorker.js') ||
      p.includes('rerankerDownloadWorker.js')
    );
  }),
  mac: {
    ...(base.mac || {}),
    icon: 'tmp/sottura-icon.png',
    identity: null,
    target: [{ target: 'zip', arch: [currentArch] }],
    extendInfo: {
      ...((base.mac && base.mac.extendInfo) || {}),
      NSScreenCaptureUsageDescription: 'Sottura needs Screen Recording permission to capture system audio and screenshots.',
      NSMicrophoneUsageDescription: 'Sottura needs microphone access for speech transcription.',
      NSAudioCaptureUsageDescription: 'Sottura needs system audio access for speech transcription.',
    },
  },
  win: {
    ...(base.win || {}),
    icon: 'tmp/sottura-icon.png',
    target: [{ target: 'nsis', arch: [currentArch] }],
  },
  linux: {
    ...(base.linux || {}),
    icon: 'tmp/sottura-icon.png',
    target: [{ target: 'AppImage', arch: [currentArch] }],
  },
};
