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
`website/` the qivo.io homepage, pricing page
and docs renderer, `desktop/` the Electron shell, and `scripts/` build and
verification tools. User-facing guides are Markdown in
[docs/guide/](docs/guide/) ([publishing rules](docs/documentation.md)); machine
contracts are in [docs/rest-api.md](docs/rest-api.md) and [docs/mcp.md](docs/mcp.md).
The agent guides `llms.txt`, `skill.md` and `auth.md` are in `public/`.

A deployment serves the website at `/`, `/docs/` and `/pricing/`, the planner
at `/app` and the operator console at `/admin`. See
[website/README.md](website/README.md).

## Development

Use Node.js 24.22.1 or a later 24.x release (`engines` in `package.json`) and
the checked-in npm lockfiles:

```sh
npm ci
npm run desktop:install
cp .env.example .env.local
```

Fill the two `VITE_CONVEX_*` placeholders with your own development backend
URLs. External contributors should provision their own Convex development
project and configure its sign-in/runtime environment; do not use Qivo's hosted
production backend as a test environment. Never commit `.env` or real credentials.
Authorized maintainers follow private instructions, `AGENTS-public-repo.md` in
`qivo-io/qivo-internal`. A `post-checkout` Git hook from their agent tooling
copies that file into each maintainer checkout as an ignored, read-only
`AGENTS.md`. It covers setup, the shared command-level credential helper and
the rules for deployments and production. If a maintainer checkout has no
`AGENTS.md`, as after the pull that stopped tracking it, switch to the branch
again, such as `git switch main`, which runs the hook, or read
`git show origin/main:AGENTS-public-repo.md` in the qivo-internal checkout. Run
no authenticated, deployment, seed, reset or production command before that.

Set backend `QIVO_ENVIRONMENT=development` explicitly. Fixture provisioning
requires private generated credentials and an absolute
`QIVO_FIXTURE_CREDENTIALS_DIR` outside the public checkout. Only a disposable
local backend (`--local`) may keep them in a private directory under the
checkout's git-ignored `dev-temp/`, which the dev server does not serve.
Deployments never provision shared accounts or reset data automatically.
They keep data, except that Convex deletes a branch preview's backend 3 days
after the branch's last push.

After configuring your development backend, `npm run dev` runs Convex and Vite
on port 5199. `/` redirects to the planner at `/app`, and the operator console
is `/admin`. Configure the backend `SITE_URL` to the exact development origin.
To see the website, run `npm run build` and then `npm run preview`.

## Verification

```sh
npm run verify:local
```

This sequential gate checks that the installed packages match the lockfiles,
formatting, lint, UI conventions, that every TypeScript file is in a
typecheck, the types of the frontend, backend, desktop app, tests and tooling,
production build and hermetic tests on four workers, as CI and the pre-push
hook run them. The build
typechecks the frontend before it bundles, and `biome ci` runs every Biome
lint rule, so the gate runs neither check a second time. `npm run typecheck`
and `npm run lint` still run them alone.
The backend check also fails when a `convex/` file that runs in
Convex's default runtime uses a Node global such as `Buffer` or a Node module.
Only the files that start with `'use node'` and the tests may, because Convex
bundles every other file for the default runtime, whichever files import it.
Convex runs the top-level `http`, `crons`, `schema`, `auth.config` and
`convex.config` files there whatever their directive. The check also fails on
an import it cannot follow, on `globalThis` or `self` used other than to read
a global by name, as in `const g = globalThis`, and on a component outside a
`convex/` directory with a `convex.config.ts`.
Types and `import type` may still name Node's types, and a file may import
`AsyncLocalStorage` and `AsyncResource` from `async_hooks`, which the default
runtime provides.
The check copies these rules from the Convex bundler and pins a hash of each
function or variable it copies them from. It fails when an installed `convex`
declares one differently, so a Convex update gets a review of the copy here
and of the module rules in `scripts/convex-api-modules.mjs`.
The backend check then runs `scripts/check-task-writes.mjs`. Task
descriptions are kept in `issue_descriptions` beside the task rows, each row
with copies of its task's project and archived state, and only
`convex/model/descriptions.ts` writes the two together. The check reads
every database `insert`, `patch` and `replace` and every call of
`insertUnique` with TypeScript's checker, also through a renamed import,
a destructured method or `db['patch']`. It fails on a task insert or
replace, a task patch whose fields may hold a description, a project or an
archived state, and a write to `issue_descriptions` anywhere else, and on a
write whose table it cannot read from its type outside the two generic
writers it allows.
Then `scripts/check-task-reads.mjs` fails on a read of
`issues.description` outside `convex/model/descriptions.ts` and the
descriptions backfill: a property or element read, or a destructuring that
binds the field, of a value whose type may be a task row. Readers take a
task's text from its description row through that file, which falls back to
`issues.description` only for a task without a row.
It needs no deployment credentials and does not reset any hosted data.
`npm run verify:static` runs every check of this gate except the tests.
When `npm run check:dependencies` fails, as after a pull or a branch switch
without a new install, run `npm ci` and `npm run desktop:install`. Builds,
tests and timings from an install that differs from the lockfiles do not show
what CI will do.

While you edit, run the tests that cover the change, and run
`npm run verify:local` before the change goes to review:

```sh
npx vitest run convex/tests/oauth.test.ts                # one file
npx vitest run convex/tests/oauth.test.ts -t 'refresh'   # tests whose name matches
npx vitest run --project node src/store                  # a directory, in one project
```

The projects are `node`, for everything outside `convex/`, and `convex`.
`npx vitest related FILE` runs every test that reaches FILE through its
imports. For a module that `src/store/planner.ts` imports, that is over a
hundred test files, and for a file that `convex/` code imports it includes
nearly every Convex test, because the Convex test helper loads all of
`convex/`.

The tests run convex-test with
[convex/convex-test#154](https://github.com/convex/convex-test/pull/154)
applied, so that a query reads only the documents of its own table.
`scripts/convex-test-table-ids.mjs` applies it as Vitest loads convex-test, and
fails on any convex-test version other than the one it was checked against.
When an upgrade includes #154, delete that patch as the file says. Otherwise
check its edits against the new version.

Do not run full gates concurrently across agents. `npm run test:contract`, demo
reset/seed commands and browser smoke tools can write to a backend; they are
not part of the safe migration gate and must target an authorized isolated
non-production deployment.

## Deployment

Successful main CI deploys the app, website and docs to persistent staging at
`https://preview.qivo.io`. Staging uses its own Vercel project, a separate
Convex backend and private credentials, and is access-protected. Feature
branches get isolated previews that include the website. Ordinary deployments
preserve test data. Branch previews are the exception, because each preview's
backend is deleted 3 days after the branch's last push.

Production follows a published GitHub Release. **Prepare release** (a manual
GitHub Actions workflow) drafts a release for exactly the commit staging
serves, and publishing that draft deploys the app, website and demo. The
deployment verifies CI, secret scanning and a successful staging deployment of
the same commit, and refuses any release older than the newest version tag.
Draft releases and prereleases do not deploy production. Vercel production
projects reject Git and deploy-hook deployment requests.

See [deployment and release operations](docs/deployment.md) for setup,
validation, failure handling and rollback. Never expose server secrets as `VITE_*`.

Desktop packaging is described in [desktop/README.md](desktop/README.md).
Desktop installers are not published yet. The manual **Desktop test build**
workflow builds unsigned Windows and Linux test installers as workflow
artifacts.

## Contributing

- Changes to access control must fail closed.
- A change to the REST API, MCP or the guide updates `docs/rest-api.md`,
  `docs/mcp.md` or `docs/guide/` in the same change. Guide slugs, headings and
  agent-guide links are public URLs, which `node scripts/docs-contract.mjs`
  checks.
- Public interfaces and documentation call work items tasks, never issues.

## Repository boundary and license

The product source, tests, public documentation and required licensed/generated
assets are public. The qivo.io website and its assets are public too. Private operational notes,
design studies, business plans and project credentials live in the access-controlled `qivo-io/qivo-internal` repo.
A clean source snapshot was copied without importing the former repository's
Git history. The existing destination license is [Apache-2.0](LICENSE).
Third-party assets retain their own license and attribution. The demo
portraits in `scripts/demo/assets/` were generated for the fictional people in
the Northstar Labs fixture, which contains no customer data.
