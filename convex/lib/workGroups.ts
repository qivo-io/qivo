/* Your work's groups (lib/overviewWork.ts), in the page's order. src/
 * imports this module, so it must stay free of server runtime. */

export const WORK_GROUPS = ['progress', 'review', 'next'] as const

export type WorkGroup = (typeof WORK_GROUPS)[number]
