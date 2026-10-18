import { expect, it } from 'vitest'

// Scratch probe that checks Start CI on a throwaway pull request. Never merge it.
it('passes, so a build of this commit can succeed', () => {
  expect('Start CI probe').toBe('Start CI probe')
})
