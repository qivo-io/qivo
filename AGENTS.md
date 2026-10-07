# Qivo agent setup

Before setting up or running authenticated commands in this repository,
read `AGENTS.md` in the private `https://github.com/qivo-io/qivo-internal`
checkout. Its default location is `$HOME/projects/qivo-internal`; use the
absolute `QIVO_INTERNAL_DIR` environment variable when the operator chose
another location. Clone the private repo there using the machine's existing
Git authentication if it is missing; do not place credentials in clone URLs.

The private instructions are not automatically discovered merely because the
repositories are siblings: explicitly read them. They define application
bootstrap, worktree environment access and production authorization rules.

Run commands needing credentials from the current checkout/worktree through
`"${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-env"`.
It reads the one shared private env file without copying it here and without
selecting a default production/development deployment. To verify access, run
`python3 "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/check-env-access.py"`.

Never copy credential values into this repository, patches, build artifacts,
logs or agent responses. Git worktrees do not copy ignored `.env` files.
Request narrow private-directory access if the execution sandbox cannot read
it; do not bypass the sandbox. Production actions still require approval.

This repository currently has no application package manifest. Do not invent
build commands or import the legacy application unless explicitly requested.
