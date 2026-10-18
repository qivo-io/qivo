import { expect, it } from 'vitest'

// Scratch probe that checks Start CI on a throwaway pull request. Never merge it. It fails
// again so branch protection can be seen blocking a failed reviewed-ci status.
it('fails on purpose so Start CI must report a failed build', () => {
  expect('Start CI probe').toBe('a passing build')
})
