/* A typed value once typing rests, as the Board's text filter and the
   Overview's health search ask the server with it. */

import { useEffect, useState } from 'react'

/** `value`, once it stayed the same for `ms`; '' at once. */
export function useRested(value: string, ms: number): string {
  const [rested, setRested] = useState(value)
  useEffect(() => {
    if (value === '') {
      setRested('')
      return
    }
    const timer = setTimeout(() => setRested(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value === '' ? '' : rested
}
