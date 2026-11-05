/* Helpers of the Roadmap reads' suites (convex/tests/roadmapRead.test.ts,
 * convex/tests/dependencies.test.ts, src/store/roadmapParity.test.ts), the
 * queries as a caller asks them, the reads inside one transaction with
 * what they read, a window of weeks, and ordinary text. Named *.setup.ts,
 * as two dots in the basename is the Convex CLI's skip rule (see
 * helpers.setup.ts). */

import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { MIB } from '../lib/limits'
import {
  type DependencyAnswer,
  type RoadmapAnswer,
  type RoadmapFilters,
  type RoadmapScope,
  type RoadmapWindow,
  readDependencies,
  readRoadmap,
} from '../lib/roadmap'
import type { ReadFigures } from './board.setup'
import { as, type T } from './helpers.setup'

/** A Roadmap filter row with every filter off. */
export const NO_ROADMAP_FILTERS: RoadmapFilters = {
  mine: false,
  owners: [],
  priority: null,
  search: '',
}

/** YYYY-MM-DD day `day` moved by `days`. */
export const dayPlus = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** The Monday of helpers.setup.ts NOW's week, 2025-12-29. */
export const NOW_WEEK = '2025-12-29'

/** A window of `weeks` weeks from the first day `from`, both ends counted. */
export const weeksFrom = (from: string, weeks: number): RoadmapWindow => ({
  from,
  to: dayPlus(from, 7 * (weeks - 1)),
})

/** The app's default window, two weeks before NOW's week to six after
 * (src/lib/dates.ts DEFAULT_WIN), on Monday weeks. */
export const DEFAULT_WINDOW: RoadmapWindow = weeksFrom(dayPlus(NOW_WEEK, -14), 9)

/** tasks.roadmap for `profile`'s login, with `filters` over
 * NO_ROADMAP_FILTERS. */
export const roadmapFor = (
  t: T,
  profile: Doc<'profiles'>,
  scope: RoadmapScope,
  filters: Partial<RoadmapFilters> = {},
  window: RoadmapWindow = DEFAULT_WINDOW,
): Promise<RoadmapAnswer> =>
  as(t, profile).query(api.tasks.roadmap, {
    scope,
    filters: { ...NO_ROADMAP_FILTERS, ...filters },
    window,
  })

/** tasks.roadmapDependencies for `profile`'s login. */
export const dependenciesFor = (
  t: T,
  profile: Doc<'profiles'>,
  scope: RoadmapScope,
): Promise<DependencyAnswer> => as(t, profile).query(api.tasks.roadmapDependencies, { scope })

/* What the transaction of `ctx` read so far, as Convex counts it. */
async function figures(ctx: Pick<QueryCtx, 'meta'>): Promise<ReadFigures> {
  const m = await ctx.meta.getTransactionMetrics()
  return {
    mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
    documents: m.documentsRead.used,
    ranges: m.databaseQueries.used,
  }
}

/** The Roadmap for the login whose seats are `seats`, read in one t.run as
 * the query reads it, with what it read. */
export const roadmapRead = (
  t: T,
  seats: readonly Doc<'profiles'>[],
  scope: RoadmapScope,
  filters: Partial<RoadmapFilters> = {},
  window: RoadmapWindow = DEFAULT_WINDOW,
): Promise<{ answer: RoadmapAnswer; read: ReadFigures }> =>
  t.run(async (ctx) => {
    const profiles = new Map(seats.map((p) => [p.org_id, p]))
    const answer = await readRoadmap(ctx, profiles, {
      scope,
      filters: { ...NO_ROADMAP_FILTERS, ...filters },
      window,
    })
    return { answer, read: await figures(ctx) }
  })

/** The dependency inputs for the login whose seats are `seats`, read in one
 * t.run as the query reads them, with what they read. */
export const dependenciesRead = (
  t: T,
  seats: readonly Doc<'profiles'>[],
  scope: RoadmapScope,
): Promise<{ answer: DependencyAnswer; read: ReadFigures }> =>
  t.run(async (ctx) => {
    const profiles = new Map(seats.map((p) => [p.org_id, p]))
    const answer = await readDependencies(ctx, profiles, { scope })
    return { answer, read: await figures(ctx) }
  })

/** The answer's row ids, sorted, or its state when it is not ok. */
export const roadmapIds = (answer: RoadmapAnswer): string[] | string =>
  answer.state === 'ok' ? answer.rows.map((row) => row.id).sort() : answer.state

/** Ordinary sentences, for titles and texts as the design size has them. */
const SENTENCES = [
  'Check why the sensor values climb slowly through the morning shift.',
  'Review the power stage of the prototype and pick parts that run cooler.',
  'Update the assembly guide with steps for the new fixture and its clamps.',
  'Sort the inspection items for next week and agree dates with the testers.',
  'Make the display text larger after feedback that it is hard to read.',
  'The dropped link seems tied to the order in which the units restart.',
  'Find a second supplier while the connector delivery is running late.',
  'Put the test results in a table that shows the change since last time.',
  'Move the most used settings to the top of the settings screen.',
  'Measure fan noise in the quiet room and compare it with the fan speed.',
  'List where the old drawings and the new layout disagree and fix them.',
  'Find the part of the specification that answers the customer question.',
]

/** `length` characters of SENTENCES from sentence `from` on. */
export const words = (from: number, length: number): string => {
  let s = ''
  for (let k = from; s.length < length; k++) s += `${SENTENCES[k % SENTENCES.length]} `
  return s.slice(0, length).trim()
}

/** The texts' length, 390 characters, the measured average. */
export const TEXT_CHARS = 390

/** An ordinary title of about 80 characters and an ordinary text, for task
 * `i`, as the Board suite's. */
export const ordinary = (i: number) => ({
  title: words(i, 72 + (i % 17)),
  text: words(i + 5, TEXT_CHARS),
})
