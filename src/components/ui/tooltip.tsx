import { Slot, Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

function hasOpenTooltip() {
  return !!document.querySelector(
    '[data-slot="tooltip-content"][data-state="delayed-open"], [data-slot="tooltip-content"][data-state="instant-open"]',
  )
}

// Tooltips hold no interactive controls (design-spec §3.1), so Radix's
// hoverable-content grace area is disabled: the tooltip closes on the
// trigger's own pointer-leave instead of lingering while the pointer crosses
// the wedge between the trigger and the bubble. Every provider mount uses
// this wrapper, because nested Radix providers do not inherit props.
function TooltipProvider({
  delayDuration = 350,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-[200] w-fit max-w-[min(24rem,var(--radix-tooltip-content-available-width))] origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 font-sans text-xs font-normal text-balance whitespace-pre-line wrap-anywhere text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

// TooltipTrigger's state belongs to the tooltip, not a composed Toggle/Select.
// Discard its button defaults before the original child receives the props;
// Slot preserves that child's own state, type, ref and event handlers.
const TooltipTarget = React.forwardRef<
  HTMLElement,
  React.ComponentPropsWithoutRef<typeof Slot.Root> & {
    enabled: boolean
    'data-state'?: string
    'data-slot'?: string
    type?: string
  }
>(function TooltipTarget(
  {
    enabled,
    'data-state': _tooltipState,
    'data-slot': _tooltipSlot,
    type: _tooltipType,
    tabIndex,
    onPointerMove,
    onPointerLeave,
    onPointerDown,
    onFocus,
    onBlur,
    onClick,
    ...props
  },
  ref,
) {
  // An empty tooltip must not report an open to Radix's shared provider:
  // that would close real tooltips and bypass the next tooltip's hover delay.
  // Original child handlers are still composed by Slot below.
  const tooltipEvents = enabled
    ? { onPointerMove, onPointerLeave, onPointerDown, onFocus, onBlur, onClick }
    : {}
  return (
    <Slot.Root
      ref={ref}
      {...(tabIndex === undefined ? {} : { tabIndex })}
      {...tooltipEvents}
      {...props}
    />
  )
})

// Keep the target's DOM, ref and event handlers intact, including grid items,
// drag handles and disabled controls. Native `title` is never forwarded.
function HoverTooltip({
  content,
  children,
}: {
  content?: React.ReactNode
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>
}) {
  const [open, setOpen] = React.useState(false)
  const hasContent =
    content !== undefined && content !== null && content !== '' && content !== false
  React.useEffect(() => {
    if (!hasContent) setOpen(false)
  }, [hasContent])
  const nativeTag = typeof children.type === 'string' ? children.type : null
  const focusable =
    nativeTag &&
    !['button', 'input', 'select', 'textarea', 'a', 'summary'].includes(nativeTag) &&
    !children.props.contentEditable
  const ignoreNested = (event: React.SyntheticEvent<HTMLElement>) => {
    if (!hasContent) return
    const target = event.target as HTMLElement
    if (target.closest('[data-tooltip-trigger]') !== event.currentTarget) event.preventDefault()
  }
  return (
    <Tooltip open={hasContent && open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        data-tooltip-trigger={hasContent ? '' : undefined}
        onPointerMove={ignoreNested}
        onFocus={ignoreNested}
        tabIndex={children.props.tabIndex ?? (hasContent && focusable ? 0 : undefined)}
      >
        <TooltipTarget enabled={hasContent}>{children}</TooltipTarget>
      </TooltipTrigger>
      {hasContent && (
        <TooltipContent
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }}
        >
          {content}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

export { HoverTooltip, hasOpenTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
