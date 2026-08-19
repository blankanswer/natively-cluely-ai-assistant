/**
 * Production macOS profile for Natively Lite CN.
 *
 * Keeps the lightweight Lite file/resource set and dedicated bundle id, but swaps
 * the ad-hoc identity for a real Developer ID Application signature, Hardened
 * Runtime, notarization and a signed/notarized DMG release artifact.
 */
process.env.NATIVELY_PRODUCTION_SIGN = '1';

const lite = require('./electron-builder.lite.cjs');
const signIdentity = process.env.NATIVELY_SIGN_IDENTITY || process.env.CSC_NAME || undefined;
const currentArch = process.arch === 'arm64' ? 'arm64' : 'x64';

module.exports = {
  ...lite,
  extraMetadata: {
    ...(lite.extraMetadata || {}),
    nativelyLiteCn: true,
    nativelySigned: true,
  },
  afterSign: './scripts/notarize.js',
  afterAllArtifactBuild: require('./scripts/afterAllArtifactBuildLite.cjs'),
  mac: {
    ...(lite.mac || {}),
    identity: signIdentity,
    icon: 'assets/lite-icon.svg',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.lite.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    notarize: false,
    // The current Lite release pipeline intentionally emits the runner's native
    // architecture only. The connected macOS CI runner is Apple Silicon, matching
    // the currently-tested Lite user path. x64 can be added as a second matrix
    // release once its native-module path has been exercised end-to-end.
    target: [{ target: 'zip', arch: [currentArch] }],
  },
};
