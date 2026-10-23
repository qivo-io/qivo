// @ts-check
const fs = require('node:fs')
const path = require('node:path')
// Read app-update.yml with the js-yaml copy electron-updater itself loads, and
// resolve feeds with the electron-builder copy that runs the build. js-yaml
// ships no types.
/** @type {{ load(text: string): unknown }} */
const yaml = require(
  require.resolve('js-yaml', { paths: [path.dirname(require.resolve('electron-updater'))] }),
)
/** @type {typeof import('app-builder-lib/out/publish/PublishManager')} */
const { getPublishConfigs, getPublishConfigsForUpdateInfo } = require(
  require.resolve('app-builder-lib/out/publish/PublishManager', {
    paths: [path.dirname(require.resolve('electron-builder'))],
  }),
)

const rootPackage = require('../package.json')

/** @typedef {import('electron-builder').AfterPackContext} AfterPackContext */

/**
 * Fails a Windows build that has an update feed but names no publisher.
 * electron-updater checks a downloaded Windows installer's signature only
 * when app-update.yml names its publisher, which electron-builder takes from
 * the signing settings: the certificate in `win.signtoolOptions` or
 * `CSC_LINK`, `win.signtoolOptions.publisherName`, or
 * `win.azureSignOptions.publisherName`. Without one, the installed app would
 * run any installer the feed offers. electron-builder writes the file before
 * afterPack runs, for a feed from QIVO_DESKTOP_UPDATE_URL or from any other
 * publish setting, so this checks every file it finds.
 * @param {string} configPath
 */
function requireWindowsPublisher(configPath) {
  if (!fs.existsSync(configPath)) return
  const updateConfig = yaml.load(fs.readFileSync(configPath, 'utf8'))
  // electron-updater skips the check when publisherName is missing or null.
  const publisherName =
    updateConfig && typeof updateConfig === 'object' && 'publisherName' in updateConfig
      ? updateConfig.publisherName
      : undefined
  const publishers = Array.isArray(publisherName) ? publisherName : [publisherName]
  if (!publishers.length || !publishers.every((name) => typeof name === 'string' && name.trim()))
    throw new Error(
      'A Windows build with an update feed must be signed with a known publisher, so the installed app checks the signature of its updates.',
    )
}

/**
 * Returns whether electron-builder would write an update feed into this app,
 * now or while a target builds. The deb, rpm and AppImage targets write
 * app-update.yml again after afterPack and may pass their own publish
 * settings, so this checks each target's settings as well as the platform and
 * top-level ones.
 * @param {AfterPackContext} context
 */
async function resolvesFeed({ packager, arch, targets }) {
  for (const options of [null, ...targets.map((target) => target.options)]) {
    const configs = await getPublishConfigsForUpdateInfo(
      packager,
      await getPublishConfigs(packager, options, arch, false),
      arch,
    )
    if (configs?.length) return true
  }
  return false
}

/**
 * Fails a build for any platform but Windows that has an update feed.
 * electron-updater checks no signature on a `.deb`, `.rpm` or AppImage
 * update, only the SHA-512 the same feed lists, so the feed alone would
 * decide what the app installs. Qivo configures no macOS build, so a macOS
 * feed is refused too. This refuses both an app-update.yml already in the
 * app and a feed electron-builder would write later.
 * @param {AfterPackContext} context
 * @param {string} configPath
 */
async function refuseFeed(context, configPath) {
  if (!fs.existsSync(configPath) && !(await resolvesFeed(context))) return
  throw new Error(
    context.electronPlatformName === 'linux'
      ? 'A Linux build cannot have an update feed until the app checks a signature on each Linux update. See "Linux builds have no update feed" in desktop/README.md.'
      : `A ${context.electronPlatformName} build cannot have an update feed. Only a Windows build signed with a known publisher can have one.`,
  )
}

/**
 * Checks the update feed of an app electron-builder has just packed.
 * @param {AfterPackContext} context
 */
async function checkUpdateFeed(context) {
  const configPath = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    'app-update.yml',
  )
  if (context.electronPlatformName === 'win32') requireWindowsPublisher(configPath)
  else await refuseFeed(context, configPath)
}

/**
 * Returns the build configuration. electron-builder calls this once for each
 * build, so every build counts the apps it checked itself.
 * @returns {import('electron-builder').Configuration}
 */
module.exports = () => {
  const updateUrl = process.env.QIVO_DESKTOP_UPDATE_URL
  if (updateUrl) {
    const url = new URL(updateUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(
        'QIVO_DESKTOP_UPDATE_URL must be an HTTPS URL without credentials, query, or hash.',
      )
    }
  }
  // electron-builder skips afterPack for an app it did not pack itself, such
  // as one given with --prepackaged, and a hook set on the command line
  // replaces this one, so a build that checked no app makes no package.
  let checkedApps = 0

  return {
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
    // Ubuntu hosts.
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
    // QIVO_DESKTOP_UPDATE_URL is set, and the installed app checks no other.
    // Only a Windows build whose app-update.yml names a signing publisher may
    // have one, and afterPack refuses a feed on any other platform. The
    // package command never publishes; the artifacts are uploaded to that
    // HTTPS feed after signing and validation.
    publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
    async afterPack(context) {
      await checkUpdateFeed(context)
      checkedApps += 1
    },
    artifactBuildStarted() {
      if (!checkedApps)
        throw new Error(
          'Package the Qivo desktop app without --prepackaged and keep the afterPack hook of desktop/electron-builder.cjs, so the build checks its update feed before it writes an installer.',
        )
    },
  }
}
