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

## Product and verification

This is the public Qivo application repository. Private design specifications,
operational notes and source migration records are in qivo-internal. Use only
`AGENTS.md` for agent instructions. Read `README.md` and `package.json`.

Use Node >=22.12, `npm ci`, `npm run desktop:install`, then
`npm run verify:local`. Run builds/tests sequentially with at most two workers.
Do not run `test:contract`, seeds, resets, live smoke drives or production
commands without explicit scope: those can modify hosted data. Real user data
must be preserved; never assume any deployment is disposable.

Source changes and public documentation should move together. Public docs are
in `docs/guide/`, `docs/rest-api.md` and `docs/mcp.md`. Keep machine terminology
as task/tasks. Guide slugs, headings and agent-guide links are public URLs;
`node scripts/docs-contract.mjs` checks them and follows the rules in
`docs/documentation.md`.

This repository is the application only. The qivo.io marketing, pricing and
rendered docs website is built in qivo-internal from this repository's
`docs/guide/` and must not be added back here. `vercel.json` proxies unknown
paths to that website only for the exact hosts `qivo.io` and `www.qivo.io`;
every other host redirects `/` to `/app`. Keep app routes and files ahead of
the proxy and run `npx vitest run scripts/vercel-routing.test.mjs` after any
routing change. Changes to application access control must fail closed.
Do not create or modify GitHub issues; Qivo work items are tasks.

Updating the connected `main` deploys both Vercel projects and corresponding
Convex backends. A main merge is a production release, not merely a Git write.
