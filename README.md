# Qivo

Work orchestration and capacity-aware planning for people and AI agents.
Qivo includes boards, roadmaps, team sync, tasks, comments, file attachments,
organization/project access controls, REST and MCP interfaces, and an Electron
shell for Windows and Linux.

- Hosted application: https://qivo.io/app
- Public demo: https://demo.qivo.io
- User documentation: https://qivo.io/docs/
- Source: https://github.com/qivo-io/qivo

## Architecture

Vite, React and TypeScript provide the planner and operator console.
Tailwind and locally owned shadcn components share the application design system.
Convex hosts the database, functions and storage; Better Auth provides sign-in
and browser-approved MCP connections. Polar supports optional billing.

`src/` contains the frontend, `convex/` the backend and hermetic backend tests,
`api/` Vercel server functions, `desktop/` the Electron shell, and `scripts/`
build and verification tools. User-facing guides are Markdown in
[docs/guide/](docs/guide/) ([publishing rules](docs/documentation.md)); machine
contracts are in [docs/rest-api.md](docs/rest-api.md) and [docs/mcp.md](docs/mcp.md).
The agent guides `llms.txt`, `skill.md` and `auth.md` are in `public/`.

This repository is the application only. The qivo.io marketing pages,
pricing page and rendered documentation are a separate website that reads
`docs/guide/` from this repository. A deployment of this repository serves
the app: `/` redirects to `/app`.

## Development

Use Node.js 22.12 or newer and the checked-in npm lockfiles:

```sh
npm ci
npm run desktop:install
cp .env.example .env.local
```

Fill the two `VITE_CONVEX_*` placeholders with your own development backend
URLs. External contributors should provision their own Convex development
project and configure its sign-in/runtime environment; do not use Qivo's hosted
production backend as a test environment. Never commit `.env` or real credentials.
Authorized maintainers follow [AGENTS.md](AGENTS.md), which points to private
setup instructions and the shared command-level credential helper.

Set backend `QIVO_ENVIRONMENT=development` explicitly. Fixture provisioning
requires private generated credentials and an absolute
`QIVO_FIXTURE_CREDENTIALS_DIR` outside the public checkout. Deployments never
provision shared accounts or reset data automatically.

After configuring your development backend, `npm run dev` runs Convex and Vite
on port 5199. `/` redirects to the planner at `/app`, and the operator console
is `/admin`. Configure the backend `SITE_URL` to the exact development origin.

## Verification

```sh
npm run verify:local
```

This sequential gate checks formatting, lint, UI conventions, frontend/backend/
desktop types, production build and hermetic tests with at most two workers.
It needs no deployment credentials and does not reset any hosted data.
Do not run full gates concurrently across agents. `npm run test:contract`, demo
reset/seed commands and browser smoke tools can write to a backend; they are
not part of the safe migration gate and must target an authorized isolated
non-production deployment.

## Deployment

Successful main CI deploys the app and website to persistent staging at
`https://preview.qivo.io`. Staging has separate Vercel projects, a separate
Convex backend, private credentials and access protection. Feature branches
retain isolated previews. Ordinary deployments preserve test data.

Manually publishing a stable GitHub Release authorizes production deployment.
The workflow verifies successful CI and staging for the exact app commit and
approved private website commit before deploying the app, website and demo.
Draft releases, prereleases and ordinary tag pushes do not deploy production.
Vercel production projects reject Git and deploy-hook deployment requests.
These workflows take effect after the implementation branches are merged.

On `qivo.io` and `www.qivo.io`, non-app paths use `https://site-origin.qivo.io`.
On `preview.qivo.io`, a server-side proxy serves the protected staging website.
Other hosts redirect `/` to `/app`. App routes and assets take precedence.
The website renders this repository's guides at the exact deployed app commit.
See [deployment and release operations](docs/deployment.md) for setup,
validation, failure handling and rollback. Never expose server secrets as `VITE_*`.

Desktop packaging and tag-derived release versions are described in
[desktop/README.md](desktop/README.md). Tags build desktop release candidates
into a draft GitHub Release. Windows installers require a valid signature.
Publication remains a manual action.

## Repository boundary and license

The product source, tests, public documentation and required licensed/generated
assets are public. Private operational notes, design studies, business plans and
project credentials live in the access-controlled `qivo-io/qivo-internal` repo.
A clean source snapshot was copied without importing the former repository's
Git history. The existing destination license is [Apache-2.0](LICENSE).
Third-party assets retain their own license and attribution. The demo
portraits in `scripts/demo/assets/` were generated for the fictional people in
the Northstar Labs fixture, which contains no customer data.
