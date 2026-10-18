/* Review evidence for Start CI (.github/workflows/reviewed-ci.yml).
 *
 * Each reviewer function reads GitHub data for one pull request and decides whether that
 * reviewer finished reviewing one exact commit. The bots do not document these formats,
 * so they were taken from this repository's pull requests. Anything missing or not
 * recognized counts as incomplete: when a bot changes its format, Start CI refuses until
 * this file learns the new one. Keep all reviewer-specific parsing here.
 *
 * Inputs use REST shapes. `statuses` and `checkRuns` belong to the commit; `comments` are
 * the pull request's conversation comments, each `{ author, editor, body, url }`, where
 * `author` and `editor` are logins such as `coderabbitai[bot]`. */

const COMMIT = /^[0-9a-f]{40}$/

/** A verdict that blocks Start CI. */
const incomplete = (name, reason, url) => ({ name, complete: false, reason, url })

/** The newest item by creation time, then by id. */
function newest(items, time) {
  return items.toSorted((a, b) => Date.parse(b[time]) - Date.parse(a[time]) || b.id - a.id)[0]
}

/**
 * The newest comment `login` wrote that contains `marker`. A comment someone else edited
 * last is skipped, because repository administrators can edit any comment.
 */
function summaryComment(comments, login, marker) {
  return comments.findLast(
    (comment) =>
      comment.author === login &&
      (!comment.editor || comment.editor === login) &&
      comment.body?.includes(marker),
  )
}

const CODERABBIT = 'coderabbitai[bot]'
const CODERABBIT_SUMMARY = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->'
// Sections CodeRabbit adds to its summary comment. Any other section blocks Start CI.
const CODERABBIT_NOTICES = {
  'review in progress': 'is still reviewing',
  'review paused': 'paused automatic reviews before this commit',
  'skip review': 'skipped this commit',
  'all tool run failures': 'reported failed review tools',
}
// Coverage kinds that state the review covers a commit. CodeRabbit carries a review
// forward over a merge of the base branch that leaves the pull request's changes alone.
const CODERABBIT_COVERAGE = new Set(['reviewed', 'target_branch_merge_carry_forward'])

/**
 * CodeRabbit finished reviewing `sha` when its newest `CodeRabbit` status on the commit is
 * "Review completed" and its summary comment says the review covers the commit. The status
 * alone is not enough: CodeRabbit also reports "Review completed" when it skips a commit.
 * A running review, a review that reported failed tools, or any notice this function does
 * not know blocks, even when an earlier review covered the commit.
 */
export function codeRabbitReview({ sha, statuses, comments }) {
  const name = 'CodeRabbit'
  if (!COMMIT.test(sha)) throw new Error('A full commit SHA is required.')
  const status = newest(
    statuses.filter((item) => item.context === 'CodeRabbit' && item.creator?.login === CODERABBIT),
    'created_at',
  )
  if (!status) return incomplete(name, 'has not posted a status on this commit')
  if (status.state !== 'success' || status.description !== 'Review completed')
    return incomplete(name, `reports "${status.description}" (${status.state}) on this commit`)

  const comment = summaryComment(comments, CODERABBIT, CODERABBIT_SUMMARY)
  if (!comment) return incomplete(name, 'has no summary comment written by CodeRabbit itself')
  const body = comment.body
  const notices = [
    ...body.matchAll(/<!-- This is an auto-generated comment: ([a-z ]+?) by coderabbit\.ai -->/g),
  ]
    .map((match) => match[1])
    .filter((notice) => notice !== 'summarize')
  for (const notice of notices)
    if (!(notice in CODERABBIT_NOTICES))
      return incomplete(name, `shows a notice this check does not know: "${notice}"`, comment.url)
  if (notices.includes('review in progress'))
    return incomplete(name, CODERABBIT_NOTICES['review in progress'], comment.url)
  if (notices.includes('all tool run failures'))
    return incomplete(name, CODERABBIT_NOTICES['all tool run failures'], comment.url)

  const coverage = [...body.matchAll(/<!-- final_review_risk_coverage:(\{[^\n]*?\}) -->/g)]
  let covered = null
  if (coverage.length === 1) {
    try {
      covered = JSON.parse(coverage[0][1])
    } catch {
      covered = null
    }
  }
  if (covered?.coveredCommitId === sha && CODERABBIT_COVERAGE.has(covered.kind))
    return { name, complete: true, reason: `reviewed ${sha.slice(0, 7)}`, url: comment.url }
  // Explain the newest state CodeRabbit reports for the pull request.
  for (const notice of ['skip review', 'review paused'])
    if (notices.includes(notice)) return incomplete(name, CODERABBIT_NOTICES[notice], comment.url)
  return incomplete(name, 'has not stated that a review covers this commit', comment.url)
}

const GREPTILE = 'greptile-apps[bot]'
const GREPTILE_APP_ID = 867647
const GREPTILE_SUMMARY = '<!-- greptile_summary -->'
const GREPTILE_REVIEWED = 'Greptile has reviewed the Pull Request.'

/**
 * Greptile finished reviewing `sha` when its newest "Greptile Review" check on the commit
 * succeeded with Greptile's "has reviewed" summary and its summary comment names the
 * commit as the last one reviewed. The confidence score is not evidence.
 */
export function greptileReview({ sha, checkRuns, comments }) {
  const name = 'Greptile'
  if (!COMMIT.test(sha)) throw new Error('A full commit SHA is required.')
  const check = newest(
    checkRuns.filter(
      (run) =>
        run.name === 'Greptile Review' && run.app?.id === GREPTILE_APP_ID && run.head_sha === sha,
    ),
    'started_at',
  )
  if (!check) return incomplete(name, 'has not started a review of this commit')
  if (check.status !== 'completed') return incomplete(name, 'is still reviewing', check.html_url)
  const summary = check.output?.summary || ''
  if (check.conclusion !== 'success' || !summary.startsWith(GREPTILE_REVIEWED))
    return incomplete(
      name,
      `did not finish its review (${check.conclusion}: "${summary.split('\n')[0]}")`,
      check.html_url,
    )

  const comment = summaryComment(comments, GREPTILE, GREPTILE_SUMMARY)
  if (!comment) return incomplete(name, 'has no summary comment written by Greptile itself')
  const reviewed = [
    ...comment.body.matchAll(
      /Last reviewed commit: \[[^\]]*\]\(https:\/\/github\.com\/qivo-io\/qivo\/commit\/([0-9a-f]{40})\)/g,
    ),
  ]
  if (reviewed.length !== 1 || reviewed[0][1] !== sha)
    return incomplete(
      name,
      'summary does not name this commit as the last one reviewed',
      comment.url,
    )
  return { name, complete: true, reason: `reviewed ${sha.slice(0, 7)}`, url: comment.url }
}

/** Every reviewer this repository requires, in report order. */
export const REVIEWERS = [codeRabbitReview, greptileReview]
