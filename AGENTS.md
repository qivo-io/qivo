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

When reviewing authentication dependency updates, check whether a published
Convex Better Auth adapter supports a patched Better Auth 1.7 or later release.
Resume the coordinated upgrade using [the upgrade checklist](docs/better-auth-upgrade.md)
when supported. Keep the advisory visible until resolved; do not bypass peer
dependencies or upgrade the OAuth provider alone.

Use Node 24, `npm ci`, `npm run desktop:install`, then
`npm run verify:local`. Run builds/tests sequentially with at most two workers.
Do not run `test:contract`, seeds, resets, live smoke drives or production
commands without explicit scope: those can modify hosted data. Real user data
must be preserved; never assume any deployment is disposable.

Source changes and public documentation should move together. Public docs are
in `docs/guide/`, `docs/rest-api.md` and `docs/mcp.md`. Keep machine terminology
as task/tasks. Guide slugs, headings and agent-guide links are public URLs;
`node scripts/docs-contract.mjs` checks them and follows the rules in
`docs/documentation.md`.

The qivo.io website (homepage, pricing and the docs rendered from
`docs/guide/`) is in `website/`. `npm run build` writes it into `dist/` after
`vite build`, so one deployment serves the website, `/app` and `/admin`. The
website build must never replace an application file, and the demo build
leaves it out. Only `demo.qivo.io` redirects `/` to `/app`. Run
`npx vitest run scripts/vercel-routing.test.mjs` after any routing change.
Changes to application access control must fail closed.
Do not create or modify GitHub issues; Qivo work items are tasks.

## Docstrings

Use concise docstrings for functions and classes, including internal code.
Follow the language’s conventions and always include a brief summary.
Add details only for non-obvious behavior, constraints, side effects, or errors.
Avoid restating the signature or implementation, and update docstrings when
behavior changes.

## Deployment and version control

Work on implementation branches.

Production Vercel projects accept REST API deployment requests only. Git pushes
and deploy hooks cannot start production builds. Successful main CI updates the
separate persistent staging environment at `preview.qivo.io`.
Publishing a stable GitHub Release authorizes production deployment of the exact
commit that passed CI and staging. Draft releases and prereleases do not deploy
production. See `docs/deployment.md` for configuration and release requirements.

Never manually deploy production to test this workflow. Preserve existing
customer data and backend identities. Staging has its own backend and private
credentials. Deployments never seed or reset data. Use `QIVO_ENVIRONMENT` to
identify the target explicitly, and keep fixture credentials outside this
checkout in the private directory chosen by `QIVO_FIXTURE_CREDENTIALS_DIR`.
