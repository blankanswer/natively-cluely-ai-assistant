const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Packed native-arch guard ───
// better-sqlite3 + keytar ship a SINGLE compiled binary each (no per-arch
// loader), so a build on an Apple-Silicon Mac can silently embed arm64 binaries
// in the x64 (`Natively.dmg`) pack — every Intel Mac then boots into main.ts's
// nativeArchGate "Architecture mismatch" dialog. scripts/rebuild-native-for-target.cjs
// (beforeBuild) rebuilds them for the correct target arch; THIS guard verifies
// the binaries actually inside the packed .app match the target arch and FAILS
// the build if they don't — closing the silent-ship hole. Runs for both the
// default (ad-hoc) and signed configs since both inherit this afterPack.
const ARCH_VERIFY_TARGETS = [
    path.join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    path.join('keytar', 'build', 'Release', 'keytar.node'),
];

/** electron-builder ArchType enum / string → Node arch string. */
function ebArchToName(arch) {
    if (arch === 1 || arch === 'x64' || arch === 'x86_64') return 'x64';
    if (arch === 3 || arch === 'arm64' || arch === 'aarch64') return 'arm64';
    return String(arch);
}

/** Mach-O arch of a .node via `file -b`, normalized to a Node arch string. */
function binaryArchOf(absPath) {
    const out = execFileSync('file', ['-b', absPath], { encoding: 'utf8' });
    if (/\barm64\b/.test(out)) return 'arm64';
    if (/\bx86_64\b/.test(out)) return 'x64';
    return `unknown (${out.trim()})`;
}

/**
 * Assert every guarded .node inside the packed .app matches the target arch.
 * Throws (failing the build) on any mismatch. Missing files are tolerated (a
 * dep layout change should not hard-fail here — the runtime gate still catches
 * a genuinely absent binary), but a WRONG arch is fatal.
 */
function verifyPackedNativeArch(appPath, targetArchName) {
    if (targetArchName !== 'x64' && targetArchName !== 'arm64') {
        console.warn(`[Arch Guard] Non-mac/unknown target arch "${targetArchName}" — skipping packed-arch verification.`);
        return;
    }
    const unpackedModules = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
    const mismatches = [];
    for (const rel of ARCH_VERIFY_TARGETS) {
        const abs = path.join(unpackedModules, rel);
        if (!fs.existsSync(abs)) {
            console.warn(`[Arch Guard] not present in pack (skipping): ${rel}`);
            continue;
        }
        const actual = binaryArchOf(abs);
        if (String(actual).startsWith('unknown')) {
            console.warn(`[Arch Guard] could not classify ${rel} (${actual}); skipping arch check for this file`);
            continue;
        }
        if (actual === targetArchName) {
            console.log(`[Arch Guard] OK ${rel} → ${actual} (target ${targetArchName})`);
        } else {
            mismatches.push({ rel, actual, expected: targetArchName });
        }
    }
    if (mismatches.length > 0) {
        const lines = mismatches.map((m) => `  - ${m.rel}: packed ${m.actual}, target needs ${m.expected}`);
        throw new Error(
            `[Arch Guard] FATAL: packed native binaries do not match the ${targetArchName} target:\n` +
            lines.join('\n') +
            `\n\nThe ${targetArchName === 'x64' ? 'Intel (Natively.dmg)' : 'Apple-Silicon (Natively-arm64.dmg)'} build would crash on launch. ` +
            `Ensure scripts/rebuild-native-for-target.cjs (build.beforeBuild) is wired and ran for this arch.`
        );
    }
    console.log(`[Arch Guard] All packed native binaries match target arch ${targetArchName} ✅`);
}

// ─── Helper Disguise Configuration ───
const DISGUISE_BASE = 'CoreServices';
const HELPER_SUFFIXES = ['', ' (GPU)', ' (Renderer)', ' (Plugin)'];

function disguiseHelperPlists(appOutDir, appName) {
    const frameworksDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Frameworks');
    if (!fs.existsSync(frameworksDir)) {
        console.log('[Helper Disguise] Frameworks directory not found, skipping.');
        return;
    }

    for (const suffix of HELPER_SUFFIXES) {
        const helperName = `${appName} Helper${suffix}`;
        const disguisedName = `${DISGUISE_BASE} Helper${suffix}`;
        const helperAppPath = path.join(frameworksDir, `${helperName}.app`);
        const plistPath = path.join(helperAppPath, 'Contents', 'Info.plist');
        if (!fs.existsSync(plistPath)) {
            console.log(`[Helper Disguise] Skipping (not found): ${helperName}.app`);
            continue;
        }
        console.log(`[Helper Disguise] ${helperName} → display as "${disguisedName}"`);
        try {
            execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName '${disguisedName}'" "${plistPath}"`, { stdio: 'pipe' });
            execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName '${disguisedName}'" "${plistPath}"`, { stdio: 'pipe' });
        } catch (err) {
            console.warn(`[Helper Disguise] PlistBuddy warning for ${helperName}:`, err.message);
        }
    }
    console.log('[Helper Disguise] All helper plists updated successfully.');
}

exports.default = async function (context) {
    if (process.platform !== 'darwin') return;

    const appOutDir = context.appOutDir;
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    const targetArchName = ebArchToName(context.arch);
    verifyPackedNativeArch(appPath, targetArchName);

    try {
        disguiseHelperPlists(appOutDir, appName);
    } catch (error) {
        console.error('[Helper Disguise] Failed to update helper plists:', error);
    }

    // A real Developer ID build is signed later by electron-builder using the
    // production entitlements + provisioning/notarization path. Never overwrite it.
    const hasRealIdentity = !!(
        process.env.NATIVELY_PRODUCTION_SIGN === '1' ||
        process.env.CSC_LINK ||
        process.env.CSC_NAME ||
        process.env.NATIVELY_SIGN_IDENTITY
    );
    if (hasRealIdentity) {
        console.log(
            '[Ad-Hoc Signing] Developer ID identity detected (CSC_LINK/CSC_NAME/NATIVELY_SIGN_IDENTITY) — ' +
            'skipping ad-hoc signing. electron-builder will sign with Developer ID; afterSign will notarize.'
        );
        return;
    }

    const hardenedOpt = process.env.NATIVELY_ADHOC_HARDENED === '1' ? '--options runtime ' : '';

    // IMPORTANT: ad-hoc CI builds MUST NOT use build/entitlements.mac.plist.
    // That production file contains `keychain-access-groups`, a restricted macOS
    // entitlement that needs authorization from a provisioning profile. An ad-hoc
    // signature has no Developer ID team/profile, so the signature can verify on disk
    // while taskgated rejects the process at launch (RBSRequestErrorDomain Code=5 /
    // NSPOSIXErrorDomain Code=153 / launchd job spawn failed).
    //
    // The ad-hoc profile contains only unrestricted/runtime entitlements. Production
    // Developer ID builds continue to use entitlements.mac.plist through
    // electron-builder.signed.cjs.
    const entitlementsPath = path.join(
        context.packager.info.projectDir,
        'build',
        'entitlements.mac.adhoc.plist'
    );

    console.log(`[Ad-Hoc Signing] Signing complete app ${appPath} with ${path.basename(entitlementsPath)}...`);

    try {
        execSync(
            `codesign --force --deep ${hardenedOpt}--entitlements "${entitlementsPath}" --sign - "${appPath}"`,
            { stdio: 'inherit' }
        );
        execSync(`codesign --verify --deep --strict --verbose=4 "${appPath}"`, { stdio: 'inherit' });

        // Guard specifically against the restricted entitlement that caused a valid-looking
        // ad-hoc app to be rejected by taskgated at spawn time.
        const claimed = execSync(`codesign -d --entitlements :- "${appPath}" 2>/dev/null || true`, {
            encoding: 'utf8',
        });
        if (claimed.includes('keychain-access-groups')) {
            throw new Error(
                '[Ad-Hoc Signing] FATAL: ad-hoc app unexpectedly claims keychain-access-groups; ' +
                'this requires a provisioning profile and can make launchd/taskgated reject the app.'
            );
        }

        console.log('[Ad-Hoc Signing] Successfully signed and verified launch-safe ad-hoc application.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed to sign/verify the application:', error);
        throw error;
    }
};
