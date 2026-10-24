/* Which scheduled jobs a deployment registers (crons.ts). Convex reads the
 * module when functions are pushed, so each case imports it afresh under one
 * QIVO_ENVIRONMENT. The expected jobs come from the module's own source, so a
 * job added there is covered here without editing this file. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import source from '../crons.ts?raw'

/** The job names crons.ts registers, read from its `crons.<schedule>('name'` calls. */
const declared = [...source.matchAll(/\bcrons\.\w+\(\s*'([^']+)'/g)].map((m) => m[1])

/** The job names the module exports when Convex reads it under `environment`. */
async function registered(environment: string | undefined) {
  vi.stubEnv('QIVO_ENVIRONMENT', environment)
  vi.resetModules()
  const crons = (await import('../crons')).default
  return Object.keys(crons.crons)
}

afterEach(() => vi.unstubAllEnvs())

describe('scheduled jobs per deployment', () => {
  it('reads every job out of crons.ts', () => {
    expect(declared.length).toBeGreaterThan(20)
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('registers every job outside a branch preview, a missing or unknown value included', async () => {
    for (const environment of [
      'production',
      'staging',
      'development',
      'demo',
      undefined,
      '',
      'Preview',
      'unknown',
    ])
      expect(await registered(environment), String(environment)).toEqual(declared)
  })

  it('registers no job on a branch preview', async () => {
    expect(await registered('preview')).toEqual([])
  })
})
