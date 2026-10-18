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

## Pull requests: reviews first, then CI

Every pull request into main finishes its automated reviews before full CI runs.
Opening a pull request, pushing to it, rebasing it or marking it ready for review
starts CodeRabbit, Greptile, secret scanning and the Vercel branch preview, never
full CI. Start CI (`.github/workflows/reviewed-ci.yml`) builds a commit only after
its reviews are finished and publishes the `reviewed-ci` status. Branch
protection on main requires `reviewed-ci`, `secrets` and `Greptile Review` on the
head commit, a branch that is up to date with main and resolved conversations.

**Reviewers.** CodeRabbit and Greptile are both required on every pull request.
`.coderabbit.yaml` and `.greptile/config.json` make them review every push and
rebase. Do not edit those files to skip or narrow a review. No formal approval
is required: branch protection asks for no approving reviews and neither bot
approves. A review that requests changes blocks Start CI until it is dismissed
or replaced.

**1. Finish the reviews of the head commit.** A review is finished only when the
reviewer reports it for the current head commit. A score, a green bot status or
an earlier commit's review does not count.

- CodeRabbit: its summary comment must state that a review covers the head. It
  posts "Review completed" even when it skipped a commit, for example after a
  rebase that changed nothing reviewable. After a skip, comment
  `@coderabbitai full review`. When it paused or was rate limited, comment
  `@coderabbitai review` once it can review again.
- Greptile: its "Greptile Review" check on the head must say it reviewed the
  pull request, and its summary must name the head as the last reviewed commit.
  A neutral "Review was cancelled" check or none at all is not a review. Comment
  `@greptileai` to start one.

Read every review body, summary comment and inline thread for the head,
including findings that could not be posted inline: CodeRabbit's "Outside diff
range" and nitpick sections and Greptile's comment about code outside the diff.
Check each finding against the source. Fix the valid ones. Reply with the reason
before resolving one you reject. Each push starts new reviews of the new head,
so finish them again before CI. Push fixes in few commits: CodeRabbit reviews a
limited number of pushes per hour for each pull request author.

**2. Check readiness.** `node scripts/reviewed-ci.mjs check PR` runs Start CI's
checks locally and read-only, with your `gh` login, and prints the dispatch
command when the pull request is ready. It reports missing or unrecognized
review evidence as not ready; never work around that.

**3. Start CI** for the exact head you reviewed:

```sh
gh workflow run reviewed-ci.yml --ref main -f pr=PR -f sha=HEAD_SHA
```

Dispatching attests that you assessed every finding, including those that need
judgment. Start CI refuses a caller without write access, a draft, a pull
request into another branch, a stale SHA, a branch behind main, unfinished
reviews, unresolved threads and requested changes, and a refusal writes no
status. It then builds the commit in the `Build and test / quality` job, which
runs the same checks as main CI with a read-only token, no secrets and
read-only cache access. Only when that job succeeded and every check still
holds does it set `reviewed-ci` to success on the commit. Watch that status, not
the dispatch run. GitHub shows a dispatched run's job checks on main's latest
commit, so a failed Start CI check there concerns a pull request, not main.
Start CI runs one request per commit at a time: a second
request waits for the first to finish, then starts nothing if it passed and
builds again if it failed.

**4. Retry and new commits.** A push to the pull request cancels the build of
the replaced commit, and a new commit has no `reviewed-ci` status until its own
reviews are finished and Start CI passes. To retry after a failure, fix the
cause or wait out the infrastructure problem, then dispatch Start CI again.
Re-running a Start CI run in the Actions interface is refused. For an older
pull request, run the check again and renew any review evidence that is missing
or outdated before you dispatch Start CI.

**5. Merge** only when your task says to. Successful CI permits merging; it does
not authorize it. Recheck the reviews of the head first.

**Changing CI.** Start CI runs main's workflow files and controller, so a pull
request that changes `.github/workflows/`, `scripts/reviewed-ci.mjs` or
`scripts/review-evidence.mjs` is built by the old version. Passing the old
workflow or a YAML check does not show that the new one works. Before merging,
rehearse the branch's version on the pull request:

```sh
gh workflow run reviewed-ci.yml --ref BRANCH -f pr=PR -f sha=HEAD_SHA
```

A rehearsal publishes `reviewed-ci (rehearsal)`, which branch protection
ignores, and is never cancelled by pushes. `gh workflow run ci.yml --ref BRANCH`
runs the branch's main CI. When a reviewer changes its comment or status format,
Start CI refuses until `scripts/review-evidence.mjs` and its tests learn the new
format from real pull request data.

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
