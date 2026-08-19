/**
 * Natively Lite CN signed-release hook.
 *
 * electron-builder creates the Developer-ID-signed + notarized ZIP/app. This hook
 * builds the user-facing DMG from that already-stapled app with create-dmg, signs
 * the DMG container, submits it to Apple's notary service, staples the ticket, and
 * mounts it again to verify the embedded app survived intact.
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRODUCT_NAME = 'Natively Lite CN';
const VOLUME_NAME = 'Natively Lite CN';

function resolveDeveloperIdIdentity() {
  if (process.env.NATIVELY_SIGN_IDENTITY) return process.env.NATIVELY_SIGN_IDENTITY;
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  try {
    const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
    const match = out.match(/"(Developer ID Application:[^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function notarytoolArgs() {
  const e = process.env;
  if (e.APPLE_API_KEY && e.APPLE_API_KEY_ID && fs.existsSync(e.APPLE_API_KEY)) {
    const args = ['--key', e.APPLE_API_KEY, '--key-id', e.APPLE_API_KEY_ID];
    if (e.APPLE_API_ISSUER) args.push('--issuer', e.APPLE_API_ISSUER);
    return args;
  }
  if (e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID) {
    return [
      '--apple-id', e.APPLE_ID,
      '--password', e.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id', e.APPLE_TEAM_ID,
    ];
  }
  if (e.APPLE_KEYCHAIN_PROFILE) {
    const args = ['--keychain-profile', e.APPLE_KEYCHAIN_PROFILE];
    if (e.APPLE_KEYCHAIN) args.push('--keychain', e.APPLE_KEYCHAIN);
    return args;
  }
  return null;
}

function findPackagedApp(outDir) {
  const preferred = path.join(outDir, process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${PRODUCT_NAME}.app`);
  if (fs.existsSync(preferred)) return preferred;
  for (const archDir of ['mac-arm64', 'mac']) {
    const dir = path.join(outDir, archDir);
    if (!fs.existsSync(dir)) continue;
    const name = fs.readdirSync(dir).find((entry) => entry.endsWith('.app'));
    if (name) return path.join(dir, name);
  }
  return null;
}

function gatekeeperVerifyApp(appPath) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
  execFileSync('spctl', ['-a', '-vvv', '-t', 'execute', appPath], { stdio: 'inherit' });
}

function verifyDmgContents(dmgPath) {
  const attach = execFileSync(
    'hdiutil',
    ['attach', dmgPath, '-nobrowse', '-readonly', '-noverify'],
    { encoding: 'utf8' },
  );
  const mountLine = attach.split('\n').find((line) => line.includes('/Volumes/'));
  const mount = mountLine ? mountLine.slice(mountLine.indexOf('/Volumes/')).trim() : '';
  if (!mount) throw new Error(`Could not locate mounted volume for ${path.basename(dmgPath)}`);

  try {
    const appName = fs.readdirSync(mount).find((entry) => entry.endsWith('.app'));
    if (!appName) throw new Error(`No .app found inside ${path.basename(dmgPath)}`);
    gatekeeperVerifyApp(path.join(mount, appName));
  } finally {
    try {
      execFileSync('hdiutil', ['detach', mount, '-quiet'], { stdio: 'ignore' });
    } catch {
      // Best effort: CI VM is disposable, but do not mask the real verification error.
    }
  }
}

function createDmg(appPath, dmgPath, identity) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-lite-dmg-'));
  const stagedApp = path.join(stage, path.basename(appPath));
  try {
    execFileSync('ditto', [appPath, stagedApp], { stdio: 'inherit' });
    fs.rmSync(dmgPath, { force: true });

    const args = [
      '--volname', VOLUME_NAME,
      '--window-pos', '200', '120',
      '--window-size', '660', '400',
      '--icon-size', '120',
      '--icon', path.basename(stagedApp), '170', '190',
      '--app-drop-link', '490', '190',
      '--hide-extension', path.basename(stagedApp),
      '--no-internet-enable',
      '--hdiutil-quiet',
      '--codesign', identity,
      dmgPath,
      stage,
    ];

    try {
      execFileSync('create-dmg', args, { stdio: 'inherit' });
    } catch (error) {
      // create-dmg exit 2 can mean Finder layout metadata could not be written in
      // a headless runner even though a valid DMG was produced.
      if (!(error && error.status === 2 && fs.existsSync(dmgPath))) throw error;
      console.warn('[lite-dmg] create-dmg exited 2 after producing the DMG; continuing with notarization.');
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = async function afterAllArtifactBuildLite() {
  if (process.platform !== 'darwin') return [];

  const creds = notarytoolArgs();
  if (!creds) throw new Error('Signed Lite DMG requires Apple notarization credentials.');
  const identity = resolveDeveloperIdIdentity();
  if (!identity) throw new Error('Signed Lite DMG requires a Developer ID Application identity.');

  const outDir = path.resolve(process.cwd(), 'release');
  const appPath = findPackagedApp(outDir);
  if (!appPath) throw new Error(`Could not find ${PRODUCT_NAME}.app under release/.`);

  // The afterSign hook must already have notarized + stapled the app before we
  // put it into the DMG. Fail here rather than ship a container around a bad app.
  gatekeeperVerifyApp(appPath);

  const version = require('../package.json').version;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dmgPath = path.join(outDir, `${PRODUCT_NAME}-${version}-mac-${arch}.dmg`);

  console.log(`[lite-dmg] Creating ${path.basename(dmgPath)} from notarized app...`);
  createDmg(appPath, dmgPath, identity);
  execFileSync('codesign', ['--verify', '--verbose=2', dmgPath], { stdio: 'inherit' });

  console.log('[lite-dmg] Submitting DMG to Apple notary service...');
  execFileSync('xcrun', ['notarytool', 'submit', dmgPath, ...creds, '--wait'], { stdio: 'inherit' });

  // Reuse the repository's retry helper to tolerate Apple's ticket propagation race.
  const { stapleWithRetry } = require('./staple-with-retry');
  await stapleWithRetry(dmgPath, { maxAttempts: 6, baseDelayMs: 15000 });
  execFileSync('xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' });
  verifyDmgContents(dmgPath);

  console.log(`[lite-dmg] Signed + notarized + stapled + verified: ${dmgPath}`);
  return [dmgPath];
};
