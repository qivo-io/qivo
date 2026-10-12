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
  files: ['dist/**/*', 'package.json'],
  // Keep one icon source for the Linux desktop entry, all package formats and
  // the Windows executable and installer. Electron-builder reads the PNG at
  // build time and converts it for Windows; it does not need to be part of
  // the application archive.
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
