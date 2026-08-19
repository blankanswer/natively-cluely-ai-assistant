/**
 * Lite CN packaging profile.
 *
 * This is intentionally independent from the upstream release/signing flow:
 * - keeps native microphone/system-audio capture
 * - does not bundle local model payloads
 * - does not emit updater metadata
 * - builds only the runner's current architecture in experimental CI
 */
const base = require('./package.json').build;

const isModelsResource = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  return typeof entry.from === 'string' && /(^|\/)resources\/models\/?$/.test(entry.from.replace(/\\/g, '/'));
};

const currentArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const isMacBuildHost = process.platform === 'darwin';

module.exports = {
  ...base,
  // Do NOT reuse upstream's com.electron.meeting-notes identity on macOS.
  // macOS TCC / LaunchServices key state off bundle identity + signing
  // requirement, so a dedicated Lite id prevents an upstream install or an
  // older ad-hoc test build from poisoning Screen Recording/Microphone state.
  // Keep Windows/Linux on the existing id so their currently-working install
  // identity and NSIS behavior do not change as part of a macOS-only fix.
  appId: isMacBuildHost ? 'com.blankanswer.natively-lite-cn' : base.appId,
  productName: 'Natively Lite CN',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  generateUpdatesFilesForAllChannels: false,
  publish: null,
  extraMetadata: {
    ...(base.extraMetadata || {}),
    nativelyLiteCn: true,
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
    identity: null,
    target: [{ target: 'zip', arch: [currentArch] }],
  },
  win: {
    ...(base.win || {}),
    target: [{ target: 'nsis', arch: [currentArch] }],
  },
  linux: {
    ...(base.linux || {}),
    target: [{ target: 'AppImage', arch: [currentArch] }],
  },
};
