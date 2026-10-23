import type { VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { buttonHooks, type buttonVariants } from './button-variants'

/** The <button> a Button with `noTooltip` renders, without the Button
    component. A row that a list renders thousands of times, such as a
    Board card, builds its buttons with it to mount fewer components. */
export function buttonElement({
  variant,
  size,
  className,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { [hook: `data-${string}`]: string | undefined }) {
  return <button {...props} {...buttonHooks(variant, size, className)} />
}
