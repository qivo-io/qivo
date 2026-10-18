import { expect, it } from 'vitest'

// Scratch probe that checks Start CI on a throwaway pull request. Never merge it. This
// commit only exists to cancel the Start CI run of the previous one.
it('passes, so a build of this commit can succeed', () => {
  expect('Start CI probe').toBe('Start CI probe')
})
