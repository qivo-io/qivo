const fs = require('node:fs')
const path = require('node:path')
// Read app-update.yml with the js-yaml copy electron-updater itself loads.
const yaml = require(
  require.resolve('js-yaml', { paths: [path.dirname(require.resolve('electron-updater'))] }),
)

const updateUrl = process.env.QIVO_DESKTOP_UPDATE_URL
const rootPackage = require('../package.json')

if (updateUrl) {
  const url = new URL(updateUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'QIVO_DESKTOP_UPDATE_URL must be an HTTPS URL without credentials, query, or hash.',
    )
  }
}

/**
 * Fails a Windows build that has an update feed but names no publisher.
 * electron-updater checks a downloaded Windows installer's signature only
 * when app-update.yml names its publisher, which electron-builder takes from
 * the signing settings: the certificate in `win.signtoolOptions` or
 * `CSC_LINK`, `win.signtoolOptions.publisherName`, or
 * `win.azureSignOptions.publisherName`. Without one, the installed app would
 * run any installer the feed offers. electron-builder writes the file before
 * this hook runs, for a feed from QIVO_DESKTOP_UPDATE_URL or from any other
 * publish setting, so the hook checks every file it finds.
 */
async function requireWindowsPublisher(context) {
  if (context.electronPlatformName !== 'win32') return
  const configPath = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    'app-update.yml',
  )
  if (!fs.existsSync(configPath)) return
  // electron-updater skips the check when publisherName is missing or null.
  const { publisherName } = yaml.load(fs.readFileSync(configPath, 'utf8')) ?? {}
  const publishers = Array.isArray(publisherName) ? publisherName : [publisherName]
  if (!publishers.length || !publishers.every((name) => typeof name === 'string' && name.trim()))
    throw new Error(
      'A Windows build with an update feed must be signed with a known publisher, so the installed app checks the signature of its updates.',
    )
}

module.exports = {
  appId: 'io.qivo.desktop',
  productName: 'Qivo',
  // Keep the installer and update channel on the same version as the web
  // application. The desktop package stays dependency-only by design.
  extraMetadata: { version: rootPackage.version },
  asar: true,
  directories: {
    app: 'desktop',
    output: 'desktop/release',
  },
  files: ['dist/**/*', 'assets/qivo.png', 'package.json'],
  // Fuses are bits in the Electron executable, flipped while packaging. These
  // turn off the ELECTRON_RUN_AS_NODE and NODE_OPTIONS variables, the
  // --inspect flags, app code outside the packaged app.asar and extra file://
  // privileges. Windows also checks app.asar against the hash electron-builder
  // writes into the executable. No fuse covers Chromium's remote debugging
  // switches. Cookie encryption stays off. Qivo keeps its sign-in in
  // localStorage, not in cookies, so it would protect nothing, and on Linux it
  // makes every start ask the keyring for its key, which shows an unlock
  // prompt when the keyring is locked.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  // Keep one icon source for the Linux desktop entry, all package formats and
  // the Windows executable and installer. Electron-builder reads the PNG at
  // build time and converts it for Windows. The shell also uses the packaged
  // PNG for its tray icon.
  linux: {
    target: [
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
      { target: 'AppImage', arch: ['x64'] },
    ],
    category: 'Office',
    icon: 'desktop/assets/qivo.png',
    syncDesktopName: true,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these placeholders.
    artifactName: 'Qivo-${version}-${arch}.${ext}',
  },
  // The static-runtime AppImage toolset avoids a libfuse2 dependency on newer
  // Ubuntu hosts while preserving AppImage self-update support.
  toolsets: { appimage: '1.0.3' },
  deb: {
    maintainer: 'Qivo <support@qivo.io>',
  },
  rpm: {
    vendor: 'Qivo',
  },
  protocols: [{ name: 'Qivo', schemes: ['qivo'] }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'desktop/assets/qivo.png',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these placeholders.
    artifactName: 'Qivo-Setup-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
  // The update feed is written into the installed app only when
  // QIVO_DESKTOP_UPDATE_URL is set, and the installed app checks no other. The
  // package command never publishes; the artifacts are uploaded to that HTTPS
  // feed after signing and validation.
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
  afterPack: requireWindowsPublisher,
}
