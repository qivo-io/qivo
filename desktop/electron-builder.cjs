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
  // turn off the ways another program could run its own code as Qivo: the
  // ELECTRON_RUN_AS_NODE and NODE_OPTIONS variables, the --inspect flags and
  // app code outside the packaged app.asar. Windows also checks app.asar
  // against the hash electron-builder writes into the executable. Cookies on
  // disk are encrypted with the OS key store; that cannot be turned off again
  // without losing the stored cookies.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
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
  // QIVO_DESKTOP_UPDATE_URL is set. The package command never publishes; the
  // artifacts are uploaded to that HTTPS feed after signing and validation.
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
}
