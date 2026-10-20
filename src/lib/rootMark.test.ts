// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { holdRootMark } from './rootMark'

describe('holdRootMark', () => {
  it('keeps the mark on <html> until the last holder releases it', () => {
    const root = document.documentElement
    const first = holdRootMark('workspace-shell')
    const second = holdRootMark('workspace-shell')
    expect(root.hasAttribute('data-workspace-shell')).toBe(true)
    first()
    // a release that runs twice cannot take the other holder's mark
    first()
    expect(root.hasAttribute('data-workspace-shell')).toBe(true)
    second()
    expect(root.hasAttribute('data-workspace-shell')).toBe(false)
  })
})
