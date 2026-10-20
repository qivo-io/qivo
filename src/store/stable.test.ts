import { describe, expect, it } from 'vitest'
import { keep, keepItems, sameData } from './stable'

describe('sameData', () => {
  it('matches plain data member by member', () => {
    expect(sameData({ a: 1, b: [1, { c: 'x' }] }, { b: [1, { c: 'x' }], a: 1 })).toBe(true)
    expect(sameData(new Map([['k', { v: 1 }]]), new Map([['k', { v: 1 }]]))).toBe(true)
    expect(sameData(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(sameData(Number.NaN, Number.NaN)).toBe(true)
    // an undefined member counts as absent, as JSON and the rows read it
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(true)
  })

  it('tells any difference apart', () => {
    expect(sameData({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameData({ a: 1 }, { a: 1, b: null })).toBe(false)
    expect(sameData([1, 2], [2, 1])).toBe(false)
    expect(sameData([1], { 0: 1 })).toBe(false)
    expect(sameData(new Map([['k', 1]]), new Map([['j', 1]]))).toBe(false)
    expect(sameData(new Set(['a']), new Set(['a', 'b']))).toBe(false)
    expect(sameData(0, -0)).toBe(false)
    expect(sameData(null, {})).toBe(false)
  })
})

describe('keepItems', () => {
  const a = { id: 'a', n: 1 }
  const b = { id: 'b', n: 2 }

  it('answers the old list when every item and the order stayed', () => {
    const prev = [a, b]
    expect(keepItems(prev, [{ ...a }, { ...b }])).toBe(prev)
  })

  it('keeps each unchanged item and takes the changed one', () => {
    const next = keepItems([a, b], [{ ...a }, { id: 'b', n: 3 }])
    expect(next[0]).toBe(a)
    expect(next[1]).toEqual({ id: 'b', n: 3 })
    expect(next[1]).not.toBe(b)
  })

  it('makes a new list for a new order, an added or a removed item', () => {
    const prev = [a, b]
    const swapped = keepItems(prev, [{ ...b }, { ...a }])
    expect(swapped).not.toBe(prev)
    expect(swapped[0]).toBe(b)
    expect(keepItems(prev, [{ ...a }])).toEqual([a])
    expect(keepItems(prev, [{ ...a }])).not.toBe(prev)
    expect(keepItems(prev, [{ ...a }, { ...b }, { id: 'c', n: 0 }])).toHaveLength(3)
  })

  it('keep answers the old value only for the same data', () => {
    const prev = { x: [1] }
    expect(keep(prev, { x: [1] })).toBe(prev)
    expect(keep(prev, { x: [2] })).toEqual({ x: [2] })
  })
})
