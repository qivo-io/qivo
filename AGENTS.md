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
selecting a default production/development deployment. Run a Convex command
against a deployment through
`"${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" TARGET COMMAND`,
which refuses a missing key, rather than exporting `CONVEX_DEPLOY_KEY` by
hand. An empty key makes the Convex CLI fall back to the deployment in
`.env.local`. The demo's stored key may not run internal functions or read
logs. Run those commands on the demo through
`"${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-temp-deploy-key"`,
which runs one command with a short-lived key, and only after the user
approves the command and its actions. To verify access, run
`python3 "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/check-env-access.py"`.

Never copy credential values into this repository, patches, build artifacts,
logs or agent responses. Git worktrees do not copy ignored `.env` files.
Request narrow private-directory access if the execution sandbox cannot read
it; do not bypass the sandbox. Production actions still require approval.

## Product and verification

This is the public Qivo application repository. Private design specifications
and operational notes are in qivo-internal. Use only
`AGENTS.md` for agent instructions. Read `README.md` and `package.json`.

Qivo runs Better Auth with its own copy of the Convex adapter in
`vendor/convex-better-auth/` (owner decision, 2026-10-24). When reviewing
authentication dependency updates, move `better-auth`, `@better-auth/core`
and `@better-auth/oauth-provider` together and port the copy, following
[the Better Auth notes](docs/better-auth-upgrade.md). Check Better Auth's
repository advisories, which `npm audit` does not show. Do not bypass peer
dependencies or upgrade the OAuth provider alone.

Use Node 24.22.1 or a later 24.x release, `npm ci`,
`npm run desktop:install`, then `npm run verify:local`. Run builds/tests
sequentially with at most two workers.
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

## Reviews before a pull request

CodeRabbit and Greptile do not review pull requests on GitHub.
`.coderabbit.yaml` and `.greptile/config.json` turn their automatic reviews
off, and they stay off. Do not start a review on GitHub with an
`@coderabbitai` or `@greptileai` comment. Every change instead gets these
reviews on this machine before its pull request opens, one after another,
each on the committed branch after the fixes of the step before. `BASE` is
the output of `git merge-base origin/main HEAD` after `git fetch origin`.

1. GPT 6 Astra at `ultra`, as a T3 `delegate_task` child with provider
   `codex`, model `gpt-6-astra` and `reasoningEffort: ultra`. It is a normal
   task with the reviewer prompt, not `codex exec review`.
2. Fix the valid findings and commit.
3. Claude Opus 5.5, as a `delegate_task` child with provider `claudeAgent`
   and model `claude-opus-5-5`, at `effort: xhigh`. It runs at
   `effort: ultracode` with the prompt's multi-agent workflow section
   instead when the change comes from a fork or alters one of these areas:
   - sign-in, sessions and tokens
   - access control
   - outside input, such as the REST API, MCP, webhooks and uploads
   - stored data, such as deletion, restore, export, migrations, the schema
     and how the app saves a person's edits
   - billing
   - the desktop shell
   - deployment, CI, secrets and the credential and production rules in
     this file

   Changes to UI, tests, docs, the review steps or dependencies stay at
   `xhigh` unless they do one of these things, as an update of Better Auth
   or Electron does. Judge what the change does, not only which files it
   touches, and when unsure, use `ultracode`. The private review README
   named below lists what each area covers.
4. Fix the valid findings and commit.
5. The CodeRabbit and Greptile CLIs, side by side, with
   `cr review --agent --committed --base-commit BASE` and
   `greptile review -b BASE --json`. When the change touches `AGENTS.md`, add
   `--include AGENTS.md` to the Greptile command. Without it Greptile leaves
   that file's changes out and reviews an empty diff.
6. Fix the valid findings and commit.
7. Push and open the pull request. Merge it once its `quality`, `secrets`
   and `Vercel – qivo` checks pass on the head commit. The `Vercel – qivo`
   preview is the only run of `convex deploy` before main. If a check fails,
   fix the cause, with a new commit if the change caused it, and wait for the
   checks again. If a check is cancelled or does not finish, do not merge,
   and report it.

If a step fails, times out or cannot run, stop before step 7 and report it.
A change that touches only lockfiles follows the lockfile rule for step 5 in
the private review README named below instead, because neither CLI can
review it.
A commit added after the pull request opens, other than a rebase without
conflict edits, gets step 1 on its own diff, and the fixes, before the merge.
A pull request opened another way, for example by Dependabot or from a fork,
gets steps 1 to 6 on its head, then merges on the same checks as step 7.

`${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/evaluations/pr-reviews/pre-pr/README.md`
has the exact steps, the reviewer prompt and how to record each step. Read it
before step 1. A reviewer gets the prompt and the committed branch, never how
the change was written. Check every finding against the code before you fix
or reject it.

Save the review statistics in qivo-internal, because choosing and paying for
these reviewers depends on what each one finds. Every branch gets one record
in `${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/evaluations/pr-reviews/pre-pr/records/`
with:

- The branch name and the pull request number, or no number if the flow
  stopped before step 7 opened one.
- Every step, including one that failed, timed out or was skipped, and every
  follow-up review.
- Each reviewer's findings, with your verdict on each one and your severity
  for each correct one.
- Each Greptile finding that reports the same problem as a CodeRabbit
  finding, so the findings that only one of them reported can be counted.

Check the record with
`python3 "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/evaluations/pr-reviews/pre-pr/check_records.py" RECORD`
and commit it to qivo-internal before your session ends, once step 7 has
opened the pull request or a step has stopped the flow. Update and commit it
again after each follow-up review and when you merge the pull request. The
README above has the record format and the commands.

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
Only a disposable local backend (`--local`) may keep them under the
checkout's git-ignored `dev-temp/`.
