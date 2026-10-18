import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { loadFailureText } from './loadFailure'

const PLAIN = 'Something went wrong while loading. Try again in a moment.'

describe('loadFailureText', () => {
  it('replaces a server fault with a plain sentence', () => {
    const fault = new Error(
      '[CONVEX Q(snapshot:forMe)] [Request ID: 3f9c2a71] Server Error\n  Called by client',
    )
    expect(loadFailureText(fault)).toBe(PLAIN)
    expect(loadFailureText('could not reach the sign-in service')).toBe(PLAIN)
    // a refusal without a sentence of its own says nothing about the cause
    expect(loadFailureText(new ConvexError({ code: 'forbidden' }))).toBe(PLAIN)
    expect(loadFailureText(new ConvexError('not signed in'))).toBe(PLAIN)
  })

  it('keeps a refusal’s own sentence, shaped as one', () => {
    const refusal = new ConvexError({ code: 'forbidden', message: 'not signed in' })
    expect(loadFailureText(refusal)).toBe('Not signed in.')
    const sentence = new ConvexError({ code: 'rule', message: 'Confirm your email first.' })
    expect(loadFailureText(sentence)).toBe('Confirm your email first.')
  })
})
