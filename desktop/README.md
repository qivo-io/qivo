# Qivo desktop app

This folder contains the Electron shell for Qivo on Windows and Linux. The
shell keeps the Qivo web client in a sandboxed Chromium renderer and exposes only the native features
that the client needs:

- The window has no application menu row. Closing it keeps Qivo running in
  the system tray by default. The tray menu offers **Open Qivo** and **Quit
  Qivo**.
- Inbox events can raise native desktop notifications. Clicking one restores
  Qivo and opens the Inbox.
- A packaged Windows build with a release feed built into it checks that
  feed, downloads updates in the background and shows a native “update
  ready” notification. Qivo waits for active edits and asks before restarting
  to install an update. A normal quit also completes a downloaded update.
  Linux builds have no feed and never update themselves.
- OAuth provider pages open in the system browser. A short-lived, one-time
  `qivo://` callback returns the result to the waiting Qivo window.

## Security

The shell follows Electron's
[security checklist](https://www.electronjs.org/docs/latest/tutorial/security):

- The renderer has context isolation, the Chromium sandbox and no Node.js.
  The preload exposes only `window.qivoDesktop`, and every IPC handler
  accepts calls only from the top-level page of the configured app origin.
- The window loads only pages of the configured app origin. A link, a
  redirect or `window.open` to any other page, sign-in providers included,
  goes to the system instead: `http`, `https`, `mailto` and `tel` links open
  in the default app, and other schemes are dropped. The shell opens no
  second window.
- [permissions.ts](permissions.ts) refuses every web permission except
  `clipboard-sanitized-write`, which copying a link, text or an image needs.
  Only the app origin's top-level page gets it. Every request from another
  origin or from a frame is refused, and so is every HID, serial and USB
  device. Inbox alerts use the preload bridge, not the web Notification API.
- The hosted app's `Content-Security-Policy` (`vercel.json`) lets the app
  and operator pages run scripts only from the deployment and the one inline
  theme script by hash. It also blocks plugins, `<base>` changes to another
  origin and framing.
- A packaged build always loads `https://qivo.io/app`. It ignores
  `QIVO_DESKTOP_URL`, so no environment setting can make a local page the
  trusted app origin. Only a run from source reads it.
- A packaged build checks for updates only at the feed written into it when
  it was built, and a build without one never checks. No environment
  variable names another feed. `QIVO_DISABLE_UPDATES=1` can only turn checks
  off. Only a Windows build can have a feed. A Linux build cannot, because
  electron-updater checks no signature on Linux updates. Before a build with
  a feed checks, the shell removes electron-updater's test variables
  `ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER`, which picks the package manager
  that would install a Linux update as root, and `TEST_UPDATER_ARCH`.
- Packaging flips Electron's
  [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses): no
  `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, app code only from
  `app.asar`, which Windows checks against its hash, and no extra `file://`
  privileges.
- A packaged build refuses to start with a Chromium switch that could hand
  its page or update feed to another server or program, or run its child
  processes through one. [switches.ts](switches.ts) lists them: accepting
  untrusted certificates, host mapping, remote debugging, child-process
  launch prefixes and command-line extensions. A run from source accepts
  every switch. Windows shows the reason in a dialog. Linux writes it to
  standard error and opens no window, so start Qivo from a terminal to read
  it. Showing a window first would start the processes and the debugging
  port those switches act on.
- The logon entry of a Linux AppImage starts the file in `APPIMAGE`. Qivo
  reads the variable only when it runs from a folder that an AppImage
  launcher set it for: the AppImage runtime's temporary folder,
  `firejail --appimage` or NixOS `appimage-run`. Otherwise Qivo ignores it,
  so a .deb or .rpm install that inherits it still starts the installed
  program. A build with a feed also removes such a value before the updater
  starts, because an AppImage update replaces the file it names. Linux builds
  have no feed today, so that removal only prepares for a signed Linux feed.
- These rules keep Qivo's own settings from redirecting it. They do not
  protect against a program that already runs as the user. Such a program
  can set loader variables such as `LD_PRELOAD`, edit the per-user Windows
  install, add a trusted certificate or read Qivo's stored data from disk.
- Cookie encryption stays off. Qivo keeps its sign-in in `localStorage`, not
  in cookies, so encryption would protect nothing. On Linux it also makes the
  shell ask the keyring for its key at start, which shows an unlock prompt
  when the keyring is locked, for example after an automatic login.

## Desktop settings

Open **Settings → User account → Desktop app**, below **Your preferences**.
This page appears only in desktop builds that support these settings. It has
four options. **Start Qivo at logon**, **Close to tray** and **Show
notifications** are enabled by default. **Minimize to tray** starts disabled:

- **Start Qivo at logon** starts Qivo in the system tray when you sign in to
  your computer. Opening Qivo yourself shows its window.
- **Close to tray** keeps Qivo running when you close its window. Turn it off
  to quit when you close the window. **Quit Qivo** in the tray menu always
  quits, regardless of this setting.
- **Minimize to tray** hides Qivo in the tray when you minimize its window.
  When it is off, minimizing keeps Qivo in the taskbar. This setting is
  independent of **Close to tray**.
- **Show notifications** controls native Inbox and update-ready alerts.
  Turning it off leaves Inbox messages and in-app update notices available.

When a desktop update is ready, the tray menu also offers **Restart and
update**, including when notifications are off. Qivo still waits for active
edits and asks before restarting.

These preferences are saved for the current OS user on this computer, not
synced with the Qivo account. A packaged build applies the defaults on its
first run, including an upgrade from a build without desktop preferences.
Saved choices are preserved on subsequent runs. Development launches never
register themselves to start at logon.

Windows uses the current user's login startup entry. Linux uses an XDG
autostart entry. Keep an AppImage at a stable path without `%` so its startup
entry can find it. Linux launchers do not reliably support `%` in executable
paths, so Qivo reports a startup error for those paths. Linux tray visibility
depends on the desktop environment's tray support. If Qivo cannot create a
tray, closing the window minimizes it to the taskbar instead of hiding it.

## Development

Install the small desktop runtime dependency set once:

```sh
npm run desktop:install
```

Start the Vite app and Electron shell together:

```sh
npm run desktop:dev
```

`desktop:dev` loads `http://localhost:5199/app`. Set `QIVO_DESKTOP_URL` when a
different local or preview origin is needed. The main process accepts only
localhost over HTTP and Qivo HTTPS origins. To run the shell from source
against another local server, compile it and start Electron yourself:

```sh
npm run desktop:compile
QIVO_DESKTOP_URL=http://localhost:5347/app npx electron desktop
```

A packaged build ignores `QIVO_DESKTOP_URL` and always loads
`https://qivo.io/app`, so test local changes with a run from source.

## Packaging and updates

Compile the desktop process and create an unsigned x64 NSIS installer on
Windows. The
installer loads the hosted Qivo web app so authentication and Convex origins
remain the same as in a browser:

```sh
npm run desktop:package
```

Artifacts are written to `desktop/release/`. The normal package command never
publishes. To build a Windows release that can check a generic HTTPS feed,
provide the feed root while packaging:

```powershell
$env:QIVO_DESKTOP_UPDATE_URL = "https://downloads.example.com/qivo/win"
npm run desktop:package
```

On Windows this build also needs the signing settings described below. The
feed must be HTTPS with no credentials, query string or fragment. Upload
the generated installer and its `latest.yml`/blockmap files to that endpoint
with the same version from `package.json`. The installed app checks only this
feed and reads no feed setting at run time. `QIVO_DISABLE_UPDATES=1` turns
checks off for diagnostics. Signing the installer is required before shipping
it to users. A build for any other platform with a feed fails, as
[Linux builds have no update feed](#linux-builds-have-no-update-feed)
explains for Linux. Qivo has no macOS build configuration.

electron-updater checks the signature of a downloaded Windows update only
when the built-in `app-update.yml` names the publisher. electron-builder
writes that name from the signing settings: the common name of the
certificate in `CSC_LINK` or `win.signtoolOptions` (`certificateFile`,
`certificateSubjectName` or `certificateSha1`), or
`win.signtoolOptions.publisherName`, or `win.azureSignOptions.publisherName`
for Azure Trusted Signing. A name alone matches any trusted certificate with
that common name, so set `win.signtoolOptions.publisherName` or
`win.azureSignOptions.publisherName` to the certificate's full subject, such
as `CN=Qivo AB, O=Qivo AB, C=SE`. electron-updater then requires every field
it names to match. Keep `win.verifyUpdateCodeSignature` unset. A Windows
build with a feed whose configuration names no publisher fails, so the
signing change must set one of these. A test signed with a self-signed
certificate needs that certificate trusted on the test machine.

electron-updater checks the signature with PowerShell. When PowerShell cannot
run at all, for example where AppLocker blocks it, the library logs a warning
and installs the update without the check. Do not block PowerShell on the
computers that run a signed build.

The build refuses `--prepackaged`. electron-builder runs none of its
packing hooks for an app it did not pack itself, so the checks on the update
feed would not run. Package the app in the same run that writes the
installer. The build also refuses to write an installer when another
`afterPack` hook replaces the one in `desktop/electron-builder.cjs`, for
example with `-c.afterPack=<file>` on the command line.

On Ubuntu 26.04 (or another x64 Linux build host), create all three Linux
artifacts with:

```sh
npm run desktop:package:linux
```

The Linux builder needs the RPM toolchain in addition to Node.js:

```sh
sudo apt-get update
sudo apt-get install -y rpm
```

This produces a Debian package (`.deb`) for Ubuntu and other Debian-family
systems, an RPM (`.rpm`) for Fedora/RHEL-family systems, and a portable
AppImage. The `.deb` is the recommended Ubuntu install format because it gets
desktop integration and dependency handling from the package manager. AppImage
is useful when installation privileges are unavailable; its ability to run
depends on the host's user-namespace and desktop security policy. These
packages have no update feed and never update themselves, as
[Linux builds have no update feed](#linux-builds-have-no-update-feed)
explains. If a hardened Ubuntu installation blocks AppImage execution, use
the `.deb` or run the AppImage with `--appimage-extract-and-run` for
diagnostics.

The Linux package command is intentionally build-only.

### Linux builds have no update feed

A Linux build with an update feed fails, whether the feed comes from
`QIVO_DESKTOP_UPDATE_URL` or another publish setting. electron-updater checks
no signature on a `.deb`, `.rpm` or AppImage update. It installs the file
whose SHA-512 the same feed lists, a `.deb` or `.rpm` as root after Qivo asks,
so whoever controls the feed or its HTTPS host would decide what the app
installs. Linux builds have no feed and never check for updates.

The change that allows a Linux feed must add all of this, and remove the
refusal in [electron-builder.cjs](electron-builder.cjs) in the same change:

- **A key the app holds.** The packaged app contains one or more Ed25519
  public keys for Linux updates. The private key stays offline with the
  release signer, never on the feed host or in a workflow that builds
  unreviewed refs. A new key ships in an update signed by the old one.
- **What it signs.** For each release, a signed manifest names the version
  and, for each Linux file, its file name and SHA-512. The signature covers
  the exact manifest bytes and is published next to `latest-linux.yml`.
- **When the app checks.** The app verifies the manifest signature before it
  downloads an update, and refuses a version that is not newer than the
  installed one. After the download it checks the file's SHA-512 against the
  signed manifest, immediately before it hands the file to the package
  manager or replaces the AppImage.
- **What happens on a mismatch.** The app deletes the downloaded file,
  installs nothing, shows no restart prompt, logs the reason and keeps
  running the installed version. It tries again at the next scheduled check.
  No setting turns the check off. A feed without a manifest, or with one
  signed by an unknown key, gets the same treatment.

## Network requests

The window loads the Qivo web app, which makes the same requests as it does
in a browser. The shell itself contacts only the update feed built into it,
and only in a packaged build that has one. Local package builds and
**Desktop test build** artifacts have no feed and never check.

A packaged build checks at startup and then every 4 hours while it runs. A
check is an HTTPS `GET` for `latest.yml` at the feed root. Linux builds have
no feed. electron-updater sends the request from its own in-memory session,
so it carries no Qivo cookies or account data. It contains:

- a `noCache` query parameter holding the current time in base 32
- `User-Agent: electron-builder` and `Cache-Control: no-cache`
- `x-user-staging-id: 00000000-0000-0000-0000-000000000000`, the same value
  on every install
- Chromium's standard request headers, such as `Accept-Language` from the
  system locale and `Accept-Encoding`

electron-updater normally creates a random ID, stores it in `.updaterId` in
the user data folder and sends it in `x-user-staging-id` to place each
install in a staged rollout. The library always sends the header and has no
option to turn the ID off. Qivo does not use staged rollouts, so
`disableStagingUserId` in [privacy.ts](privacy.ts) sets the ID to the nil
UUID before the first check, and the app never reads or writes the file. If
release metadata ever sets `stagingPercentage`, every install updates at
once, and 0 holds back every install.

When the feed lists a newer version, the app downloads the files named in
that metadata, such as the installer and its blockmap, from the same feed.
On Windows, a differential download also requests the installed version's
blockmap unless it is cached, and that URL names the installed version.
Those downloads carry no staging ID.

Chromium's spellchecker normally downloads a Hunspell dictionary from a
Google server for every session, including electron-updater's. The shell
prevents those downloads. Linux has no other spellchecker, so the Linux app
does not check spelling. On Windows, Chromium uses the Windows spellchecker
where it supports the language and otherwise falls back to a downloaded
dictionary. The shell blocks that fallback, so such a language stays
unchecked. Spellchecking on a Windows build has not been tested. The
shell never starts Electron's crash reporter, so it uploads no crash
reports.

## Build dependency security

The root package overrides `roarr` to `6.0.0` only for `global-agent@3.0.0`,
which `app-builder-lib` uses through `@electron/get` for packaging downloads.
That logger uses `fast-printf` instead of the unpatched `sprintf-js`, addressing
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
Version 6 retains the default logger export and child logger methods used by
the proxy library. Its optional diagnostic logs use string sequence IDs.
Version 7 changes the logger export. Upgrading `global-agent` to `4.1.3`
instead failed HTTPS certificate hostname validation with this downloader.

The `scripts/electron-download.test.mjs` tests exercise proxy downloads,
`NO_PROXY` and rejection of corrupt downloads with diagnostic logging enabled.
Local HTTPS proxy tests also verify trusted certificates and reject untrusted
certificates and hostname mismatches without disabling TLS verification.
Remove the override once electron-builder's dependency tree no longer needs it.

This affects build tooling, not the installed desktop runtime. Better Auth
and Qivo's copy of its Convex adapter are described in
[the Better Auth notes](../docs/better-auth-upgrade.md).

## Test builds and release plan

Desktop installers are not published yet. Run **Desktop test build** in GitHub
Actions with a branch, tag or commit to get Windows and Linux installers as
workflow artifacts, kept for 7 days. The workflow never creates or changes a
GitHub Release and sets no update feed, so test installs never update
themselves. The installers are unsigned, so Windows SmartScreen warns about
them. The workflow can build any ref, including code that is not reviewed, so
it must never receive signing credentials. The Linux job uses Ubuntu 24.04 to
keep the glibc baseline portable; the resulting Debian package is suitable for
Ubuntu 26.04.

The shell loads the hosted web app, so web releases reach desktop users within
about a minute without a new installer. When desktop publishing starts, the
installers belong on the same GitHub Release as the web version, attached to
the draft before it is published, because the stable update feed
(`releases/latest/download/`) always reads the newest stable release. A new
shell build is only needed when the shell itself changes; rebuilding it for
every web release would make every user download and reinstall an unchanged
app. Decide the feed, signing and shell versioning before the first public
installer, because installed shells keep the feed URL they were built with.
