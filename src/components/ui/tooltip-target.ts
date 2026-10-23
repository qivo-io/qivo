import type * as React from 'react'
import { cloneElement } from 'react'

/** The element a tooltip goes on. */
export type TooltipTargetElement = React.ReactElement<React.HTMLAttributes<HTMLElement>>

export const hasTooltipContent = (content: React.ReactNode) =>
  content !== undefined && content !== null && content !== '' && content !== false

/** The target's tab index: its own, or 0 for a plain element that has
    content to show, so keyboard users can reach the tooltip. */
export function tooltipTabIndex(children: TooltipTargetElement, hasContent: boolean) {
  const nativeTag = typeof children.type === 'string' ? children.type : null
  const focusable =
    nativeTag &&
    !['button', 'input', 'select', 'textarea', 'a', 'summary'].includes(nativeTag) &&
    !children.props.contentEditable
  return children.props.tabIndex ?? (hasContent && focusable ? 0 : undefined)
}

/** The target of a tooltip in a static row (liveControls.tsx): `children`
    alone, with the attributes a closed live tooltip gives it, in the order
    the live trigger's props land. */
export function staticTooltipTarget(content: React.ReactNode, children: TooltipTargetElement) {
  const hasContent = hasTooltipContent(content)
  return cloneElement(children, {
    tabIndex: tooltipTabIndex(children, hasContent),
    'data-tooltip-trigger': hasContent ? '' : undefined,
  } as React.HTMLAttributes<HTMLElement>)
}
