/** The task display prefix is fixed across organizations. */
export const ISSUE_PREFIX = 'QN'

export const issueKey = (num: number): string => `${ISSUE_PREFIX}-${num}`
