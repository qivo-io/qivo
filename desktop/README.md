# Qivo desktop app

This folder contains the Electron shell for Qivo on Windows and Linux. The
shell keeps the Qivo web client in a sandboxed Chromium renderer and exposes only the native features
that the client needs:

- Inbox events can raise native desktop notifications. Clicking one restores
  Qivo and opens the Inbox.
- Packaged builds check the configured release feed, download updates in the
  background and show a native “update ready” notification. Qivo waits for
  active edits and asks before restarting to install an update. A normal quit
  also completes a downloaded update.
- OAuth provider pages open in the system browser. A short-lived, one-time
  `qivo://` callback returns the result to the waiting Qivo window.

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
