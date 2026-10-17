# Qivo desktop app

This folder contains the Electron shell for Qivo on Windows and Linux. The
shell keeps the Qivo web client in a sandboxed Chromium renderer and exposes only the native features
that the client needs:

- The window has no application menu row. Closing it keeps Qivo running in
  the system tray by default. The tray menu offers **Open Qivo** and **Quit
  Qivo**.
- Inbox events can raise native desktop notifications. Clicking one restores
  Qivo and opens the Inbox.
- Packaged builds check the configured release feed, download updates in the
  background and show a native “update ready” notification. Qivo waits for
  active edits and asks before restarting to install an update. A normal quit
  also completes a downloaded update.
- OAuth provider pages open in the system browser. A short-lived, one-time
  `qivo://` callback returns the result to the waiting Qivo window.

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
localhost over HTTP and Qivo HTTPS origins.

## Packaging and updates

Compile the desktop process and create an unsigned x64 NSIS installer on
Windows. The
installer loads the hosted Qivo web app so authentication and Convex origins
remain the same as in a browser:

```sh
npm run desktop:package
```

Artifacts are written to `desktop/release/`. The normal package command never
publishes. To build a release that can check a generic HTTPS feed, provide the
feed root while packaging:

```powershell
$env:QIVO_DESKTOP_UPDATE_URL = "https://downloads.example.com/qivo/win"
npm run desktop:package
```

The feed must be HTTPS with no credentials, query string or fragment. Upload
the generated installer and its `latest.yml`/blockmap files to that endpoint
with the same version from `package.json`. The installed app can override the
feed at runtime with the same environment variable; `QIVO_DISABLE_UPDATES=1`
disables checks for diagnostics. Signing the installer is required before
shipping it to users.

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
depends on the host's user-namespace and desktop security policy. Linux update
installation for `.deb` and `.rpm` asks before invoking the package manager;
AppImage updates replace the downloaded image in place. If a hardened Ubuntu
installation blocks AppImage execution, use the `.deb` or run the AppImage
with `--appimage-extract-and-run` for diagnostics.

The Linux package command is intentionally build-only.

## Network requests

The window loads the Qivo web app, which makes the same requests as it does
in a browser. The shell itself contacts only the update feed, and only in a
packaged build that has one. Local package builds and **Desktop test build**
artifacts have no feed and never check.

A packaged build checks at startup and then every 4 hours while it runs. A
check is an HTTPS `GET` for `latest.yml` on Windows or `latest-linux.yml` on
Linux at the feed root. electron-updater sends it from its own in-memory
session, so it carries no Qivo cookies or account data. It contains:

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

This affects build tooling, not the installed desktop runtime. The separate
[Better Auth security upgrade](../docs/better-auth-upgrade.md) remains blocked
by the Convex adapter's peer dependency range.

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
