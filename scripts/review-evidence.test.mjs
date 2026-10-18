import { describe, expect, it } from 'vitest'
import { codeRabbitReview, greptileReview } from './review-evidence.mjs'

// Shapes and texts follow what the bots posted on this repository's pull requests.
const SHA = 'a'.repeat(40)
const OLDER = 'b'.repeat(40)
const CODERABBIT = 'coderabbitai[bot]'
const GREPTILE = 'greptile-apps[bot]'

const status = (description, state = 'success', change = {}) => ({
  id: 1,
  context: 'CodeRabbit',
  state,
  description,
  created_at: '2026-10-18T06:00:00Z',
  creator: { login: CODERABBIT },
  ...change,
})
const notice = (name, text) =>
  `<!-- This is an auto-generated comment: ${name} by coderabbit.ai -->\n\n${text}\n\n` +
  `<!-- end of auto-generated comment: ${name} by coderabbit.ai -->`
const coverage = (covered, kind = 'reviewed', source = covered) =>
  `<!-- final_review_risk_coverage:${JSON.stringify({ sourceCommitId: source, coveredCommitId: covered, kind })} -->`
const summary = (...parts) => ({
  author: CODERABBIT,
  editor: CODERABBIT,
  url: 'https://github.com/qivo-io/qivo/pull/1#issuecomment-1',
  body: [
    '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->',
    '<!-- recent_review_start -->',
    'No actionable comments were generated in the recent review. 🎉',
    '<!-- recent_review_end -->',
    ...parts,
  ].join('\n'),
})
const skipped = notice(
  'skip review',
  '> [!IMPORTANT]\n> ## Review skipped\n> \n> Review was skipped as selected files did not have any reviewable changes.',
)
const paused = (latest) =>
  notice('review paused', `> [!NOTE]\n> ## Reviews paused\n> \n> - Last reviewed commit: ${latest}`)

describe('CodeRabbit evidence', () => {
  const review = (statuses, comments) => codeRabbitReview({ sha: SHA, statuses, comments })

  it('accepts a completed review that covers the commit', () => {
    expect(review([status('Review completed')], [summary(coverage(SHA))])).toMatchObject({
      name: 'CodeRabbit',
      complete: true,
    })
  })

  it('accepts a review carried forward over a merge of main', () => {
    const merge = coverage(SHA, 'target_branch_merge_carry_forward', OLDER)
    expect(review([status('Review completed')], [summary(merge)]).complete).toBe(true)
  })

  it('accepts a covered commit whose later automatic reviews are paused', () => {
    const comments = [summary(coverage(SHA), paused(SHA))]
    expect(review([status('Review completed')], comments).complete).toBe(true)
  })

  it('refuses a skipped commit even though the status says the review completed', () => {
    // After a rebase CodeRabbit skips the new head and keeps covering the old one.
    expect(review([status('Review completed')], [summary(coverage(OLDER), skipped)])).toMatchObject(
      {
        complete: false,
        reason: 'skipped this commit',
      },
    )
  })

  it('refuses a commit that arrived after automatic reviews paused', () => {
    const comments = [summary(coverage(OLDER), paused(OLDER))]
    expect(review([status('Review completed')], comments).reason).toBe(
      'paused automatic reviews before this commit',
    )
    expect(review([status('Review paused')], comments).reason).toBe(
      'reports "Review paused" (success) on this commit',
    )
  })

  it('refuses while a review runs, judged by the newest status', () => {
    const statuses = [
      status('Review completed', 'success', { id: 1, created_at: '2026-10-18T06:00:00Z' }),
      status('Review in progress', 'pending', { id: 2, created_at: '2026-10-18T06:05:00Z' }),
    ]
    expect(review(statuses, [summary(coverage(SHA))]).reason).toBe(
      'reports "Review in progress" (pending) on this commit',
    )
    const running = notice('review in progress', '> Currently processing new changes in this PR.')
    expect(review([status('Review completed')], [summary(coverage(SHA), running)]).reason).toBe(
      'is still reviewing',
    )
  })

  it('refuses failed tools and notices it does not know, even on a covered commit', () => {
    const failed = notice(
      'all tool run failures',
      '> Tools execution failed with the following error:',
    )
    expect(review([status('Review completed')], [summary(coverage(SHA), failed)]).reason).toBe(
      'reported failed review tools',
    )
    const limited = notice('rate limited', '> Rate limit exceeded')
    expect(review([status('Review completed')], [summary(coverage(SHA), limited)]).reason).toBe(
      'shows a notice this check does not know: "rate limited"',
    )
  })

  it('refuses missing, foreign and malformed evidence', () => {
    expect(review([], [summary(coverage(SHA))]).reason).toBe(
      'has not posted a status on this commit',
    )
    const foreign = status('Review completed', 'success', { creator: { login: 'lincarl' } })
    expect(review([foreign], [summary(coverage(SHA))]).complete).toBe(false)
    expect(review([status('Review completed')], []).complete).toBe(false)
    const edited = { ...summary(coverage(SHA)), editor: 'lincarl' }
    expect(review([status('Review completed')], [edited]).reason).toBe(
      'has no summary comment written by CodeRabbit itself',
    )
    const broken = summary('<!-- final_review_risk_coverage:{"coveredCommitId": -->')
    expect(review([status('Review completed')], [broken]).complete).toBe(false)
    const twice = summary(coverage(SHA), coverage(SHA))
    expect(review([status('Review completed')], [twice]).complete).toBe(false)
    const unknownKind = summary(coverage(SHA, 'assumed'))
    expect(review([status('Review completed')], [unknownKind]).complete).toBe(false)
  })
})

const check = (change = {}) => ({
  id: 1,
  name: 'Greptile Review',
  head_sha: SHA,
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-10-18T06:00:00Z',
  html_url: 'https://github.com/qivo-io/qivo/runs/1',
  app: { id: 867647, slug: 'greptile-apps' },
  output: {
    title: 'Base review',
    summary: 'Greptile has reviewed the Pull Request.\n\n15 files reviewed, 0 comments added.',
  },
  ...change,
})
const greptileSummary = (reviewed, change = {}) => ({
  author: GREPTILE,
  editor: GREPTILE,
  url: 'https://github.com/qivo-io/qivo/pull/1#issuecomment-2',
  body:
    '<!-- greptile_summary -->\n\n<h2>Confidence Score: 5/5</h2>\n\n<!-- greptile_confidence_score:5 -->\n\n' +
    `<sub>Reviews (2) · Last reviewed commit: ["fix(web): keep it"](https://github.com/qivo-io/qivo/commit/${reviewed}) · ` +
    '[Reviewed by Greptile](https://www.greptile.com/)</sub>',
  ...change,
})

describe('Greptile evidence', () => {
  const review = (checkRuns, comments) => greptileReview({ sha: SHA, checkRuns, comments })

  it('accepts a finished review whose summary names the commit', () => {
    expect(review([check()], [greptileSummary(SHA)])).toMatchObject({
      name: 'Greptile',
      complete: true,
    })
  })

  it('refuses a cancelled, running or missing review', () => {
    const cancelled = check({ conclusion: 'neutral', output: { summary: 'Review was cancelled' } })
    expect(review([cancelled], [greptileSummary(SHA)]).reason).toBe(
      'did not finish its review (neutral: "Review was cancelled")',
    )
    const running = check({ status: 'in_progress', conclusion: null })
    expect(review([running], [greptileSummary(SHA)]).reason).toBe('is still reviewing')
    expect(review([], [greptileSummary(SHA)]).reason).toBe(
      'has not started a review of this commit',
    )
  })

  it('judges the newest check and ignores checks from other apps', () => {
    const older = check({ id: 1, started_at: '2026-10-18T06:00:00Z' })
    const newer = check({ id: 2, started_at: '2026-10-18T06:10:00Z', status: 'in_progress' })
    expect(review([older, newer], [greptileSummary(SHA)]).complete).toBe(false)
    const impostor = check({ app: { id: 1, slug: 'greptile-apps' } })
    expect(review([impostor], [greptileSummary(SHA)]).complete).toBe(false)
  })

  it('refuses a summary of another commit or one someone else edited', () => {
    expect(review([check()], [greptileSummary(OLDER)]).reason).toBe(
      'summary does not name this commit as the last one reviewed',
    )
    expect(review([check()], [greptileSummary(SHA, { editor: 'lincarl' })]).complete).toBe(false)
    expect(review([check()], []).complete).toBe(false)
  })

  it('does not treat a successful check without the reviewed summary as a review', () => {
    const vague = check({ output: { summary: 'Done.' } })
    expect(review([vague], [greptileSummary(SHA)]).complete).toBe(false)
  })
})
