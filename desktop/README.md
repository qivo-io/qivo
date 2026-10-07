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

The Linux package command is intentionally build-only. A release workflow can
upload its artifacts and generated update metadata to GitHub Releases (or
another HTTPS generic feed) after signing and testing them. GitHub's public
release provider works for public downloads; users cannot anonymously fetch
update assets from a private source repository, so a public release repository
or HTTPS download host is needed for automatic updates in that case.

The release is intentionally generic rather than tied to the private source
repository. Local packages use the version in the root `package.json`. Tagged
releases use the tag as their version: push `v1.4.0` and the GitHub Actions
workflow in `.github/workflows/desktop-release.yml` validates the tag, applies
`1.4.0` to both package manifests in its temporary checkout, builds Windows
and Linux artifacts, adds SHA-256 checksums, and prepares a draft GitHub Release for manual publication.
No package-version commit is created. The workflow requires a valid Windows
installer signature and never overwrites an already published release. Configure the `WINDOWS_CSC_LINK` and
`WINDOWS_CSC_KEY_PASSWORD` repository secrets before shipping a signed Windows
installer. Linux package signing can be added to the release job when a package
signing key is available. A prerelease tag prepares a draft prerelease for
testing and uses its tag-specific update feed. Publishing a stable release
also authorizes the hosted production deployment described in
[deployment and releases](../docs/deployment.md). Review staging and wait for
the installer build to finish before publishing the draft. Stable releases use the
`latest/download` feed, which intentionally follows the latest non-prerelease
release. The hosted Linux job uses Ubuntu 24.04 to keep the glibc baseline
portable; the resulting Debian package is suitable for Ubuntu 26.04.
