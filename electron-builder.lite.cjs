/**
 * Lite CN packaging profile.
 *
 * Goal: keep the existing full Natively build untouched while producing a
 * smaller BYOK-oriented package that does not bundle the local model payload.
 * The native audio capture module is intentionally retained because mic/system
 * loopback capture still depends on it.
 *
 * Build after the normal renderer/electron compilation steps with:
 *   node scripts/package-app.js --config electron-builder.lite.cjs
 *
 * This first Lite profile removes packaged model assets only. ONNX/HuggingFace
 * dependencies remain installed for now because upstream modules still import
 * them from several optional code paths; removing those packages safely is a
 * second-stage refactor rather than a packaging-only change.
 */

const base = require('./package.json').build;

const isModelsResource = (entry) => {
  if (!entry || typeof entry !== 'object') return false;
  return typeof entry.from === 'string' && /(^|\/)resources\/models\/?$/.test(entry.from.replace(/\\/g, '/'));
};

module.exports = {
  ...base,
  productName: 'Natively Lite CN',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Lite builds are intended for BYOK/manual distribution. Do not generate the
  // upstream auto-update metadata/channel files for this fork profile.
  generateUpdatesFilesForAllChannels: false,
  extraMetadata: {
    ...(base.extraMetadata || {}),
    nativelyLiteCn: true,
  },
  extraResources: (base.extraResources || []).filter((entry) => !isModelsResource(entry)),
  // Remove worker/model-specific unpack rules from the Lite package. These are
  // only useful when the corresponding local model payload is shipped.
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
};
