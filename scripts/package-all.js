/**
 * Cross-platform packaging script.
 * Uses @electron/packager (no Wine needed) and zips each output.
 *
 * Usage:
 *   npm run package              – build for all platforms
 *   npm run package:win          – Windows x64 only
 *   npm run package:mac          – macOS x64 + arm64
 *   npm run package:linux        – Linux x64 only
 *   node scripts/package-all.js win mac linux
 */

const packager  = require('@electron/packager');
const AdmZip    = require('adm-zip');
const path      = require('path');
const os        = require('os');
const fs        = require('fs');

const root        = path.join(__dirname, '..');
const pkg         = require(path.join(root, 'package.json'));
const electronVer = require(path.join(root, 'node_modules/electron/package.json')).version;

const APP_NAME   = (pkg.build && pkg.build.productName) || pkg.name;
const APP_VER    = pkg.version;
const DIST_DIR   = path.join(root, 'dist', 'releases');
// Keep large Electron downloads off the small /tmp tmpfs
const CACHE_DIR  = path.join(os.homedir(), '.cache', 'electron-packager');

const ALL_TARGETS = [
  { short: 'win',   platform: 'win32',  arch: 'x64',   label: 'Windows-x64'    },
  { short: 'mac',   platform: 'darwin', arch: 'x64',   label: 'macOS-x64'      },
  { short: 'mac',   platform: 'darwin', arch: 'arm64', label: 'macOS-arm64'    },
  { short: 'linux', platform: 'linux',  arch: 'x64',   label: 'Linux-x64'      },
];

// Resolve which targets to build from CLI args
const requested = process.argv.slice(2).map(a => a.toLowerCase());
const targets = requested.length
  ? ALL_TARGETS.filter(t => requested.includes(t.short))
  : ALL_TARGETS;

if (targets.length === 0) {
  console.error('Unknown target. Use: win | mac | linux  (or omit for all)');
  process.exit(1);
}

// ── Zip helper (pure Node.js via adm-zip — no shell `zip` needed) ─────────────
function zipDirectory(srcDir, destZip) {
  const zip = new AdmZip();
  const folderName = path.basename(srcDir);
  zip.addLocalFolder(srcDir, folderName);
  zip.writeZip(destZip);
}

function mb(file) {
  return (fs.statSync(file).size / 1_048_576).toFixed(0) + ' MB';
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`\nDoc Harvester v${APP_VER} — packaging: ${targets.map(t => t.label).join(', ')}\n`);

  for (const { platform, arch, label } of targets) {
    const tmpOut  = path.join(DIST_DIR, `_tmp-${platform}-${arch}`);
    const zipPath = path.join(DIST_DIR, `DocHarvester-${label}-v${APP_VER}.zip`);

    console.log(`▶  ${label}…`);

    // Clean up any leftover temp dir
    fs.rmSync(tmpOut, { recursive: true, force: true });

    await packager({
      dir:             root,
      name:            APP_NAME,
      platform,
      arch,
      out:             tmpOut,
      electronVersion: electronVer,
      overwrite:       true,
      prune:           true,
      // Download Electron to ~/.cache instead of /tmp
      download: { cacheRoot: CACHE_DIR },
      ignore: [
        /^[/\\]dist([/\\]|$)/,
        /^[/\\]\.github/,
        /^[/\\]\.git([/\\]|$)/,
        /^[/\\]scripts([/\\]|$)/,
        /^[/\\]node_modules[/\\]electron([/\\]|$)/,
        /^[/\\]node_modules[/\\]electron-builder/,
        /^[/\\]node_modules[/\\]@electron[/\\]packager/,
        /^[/\\]node_modules[/\\]archiver/,
        /^[/\\]node_modules[/\\]\.cache/,
      ],
    });

    // electron-packager names output: "<Name>-<platform>-<arch>"
    const folderName = `${APP_NAME}-${platform}-${arch}`;
    const appDir     = path.join(tmpOut, folderName);

    if (!fs.existsSync(appDir)) {
      throw new Error(`Expected output not found: ${appDir}`);
    }

    process.stdout.write(`   Zipping…`);
    zipDirectory(appDir, zipPath);
    console.log(` ✓  ${path.basename(zipPath)}  (${mb(zipPath)})`);

    // Remove unpacked temp dir immediately to preserve disk space
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }

  console.log('\n✓ All done! Files in dist/releases/\n');
  fs.readdirSync(DIST_DIR)
    .filter(f => f.endsWith('.zip'))
    .forEach(f => {
      const p = path.join(DIST_DIR, f);
      console.log(`  ${f.padEnd(44)}  ${mb(p)}`);
    });
})().catch(err => {
  console.error('\n✗ Build failed:', err.message);
  process.exit(1);
});
