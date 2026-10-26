import { Slot, Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'

import { useStaticControls } from '@/lib/liveControls'
import { passEscapeOn } from '@/lib/passEscapeOn'
import { cn } from '@/lib/utils'
import { LayerOpenContext, useLayerOpen, useViewHidden } from '@/lib/viewHidden'
import {
  hasTooltipContent,
  staticTooltipTarget,
  type TooltipTargetElement,
  tooltipTabIndex,
} from './tooltip-target'

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

function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const layer = useLayerOpen({ open, defaultOpen, onOpenChange })
  return (
    <LayerOpenContext.Provider value={layer.open}>
      <TooltipPrimitive.Root data-slot="tooltip" {...layer.props} {...props} />
    </LayerOpenContext.Provider>
  )
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
  // open in a hidden kept view (lib/viewHidden.ts)
  if (useViewHidden(React.useContext(LayerOpenContext))) return null
  // a tooltip lets presses through to the control under it (tokens.css)
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
  // A kept page (components/KeptView) detaches every ref as it hides and
  // attaches it again as it shows. Only an element goes on to Radix, whose
  // trigger then stays meanwhile, so the page's tooltips do not render
  // again, hidden or before the page paints.
  const attach = React.useCallback(
    (element: HTMLElement | null) => {
      if (!element) return
      if (typeof ref === 'function') ref(element)
      else if (ref) ref.current = element
    },
    [ref],
  )
  // An empty tooltip must not report an open to Radix's shared provider:
  // that would close real tooltips and bypass the next tooltip's hover delay.
  // Original child handlers are still composed by Slot below.
  const tooltipEvents = enabled
    ? { onPointerMove, onPointerLeave, onPointerDown, onFocus, onBlur, onClick }
    : {}
  return (
    <Slot.Root
      ref={attach}
      {...(tabIndex === undefined ? {} : { tabIndex })}
      {...tooltipEvents}
      {...props}
    />
  )
})

type HoverTooltipProps = {
  content?: React.ReactNode
  children: TooltipTargetElement
}

// Keep the target's DOM, ref and event handlers intact, including grid items,
// drag handles and disabled controls. Native `title` is never forwarded.
// Inside a static row (liveControls.tsx) the target renders alone, with the
// attributes a closed live tooltip gives it, until the row goes live.
// rowElements.tsx's hoverTooltip renders the same without a component.
function HoverTooltip({ content, children }: HoverTooltipProps) {
  if (useStaticControls()) return staticTooltipTarget(content, children)
  return <LiveTooltip content={content}>{children}</LiveTooltip>
}

/** HoverTooltip outside a static row. */
function LiveTooltip({ content, children }: HoverTooltipProps) {
  const [open, setOpen] = React.useState(false)
  // closed by Escape: skip the exit animation, so the tooltip leaves Radix's
  // layer stack at once and the Escape can go on to the layer below. Only an
  // open tooltip skips it: removing an exit animation that already runs
  // cancels it, Radix's Presence then waits for an end that never comes,
  // and the closed tooltip stays the top layer and takes every Escape.
  const [escaped, setEscaped] = React.useState(false)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const hasContent = hasTooltipContent(content)
  React.useEffect(() => {
    if (!hasContent) setOpen(false)
  }, [hasContent])
  const ignoreNested = (event: React.SyntheticEvent<HTMLElement>) => {
    if (!hasContent) return
    const target = event.target as HTMLElement
    if (target.closest('[data-tooltip-trigger]') !== event.currentTarget) event.preventDefault()
  }
  return (
    <Tooltip
      open={hasContent && open}
      onOpenChange={(next) => {
        if (next) setEscaped(false)
        setOpen(next)
      }}
    >
      <TooltipTrigger
        asChild
        data-tooltip-trigger={hasContent ? '' : undefined}
        onPointerMove={ignoreNested}
        onFocus={ignoreNested}
        tabIndex={tooltipTabIndex(children, hasContent)}
      >
        <TooltipTarget enabled={hasContent}>{children}</TooltipTarget>
      </TooltipTrigger>
      {hasContent && (
        <TooltipContent
          ref={contentRef}
          className={escaped ? 'data-[state=closed]:!animate-none' : undefined}
          onEscapeKeyDown={(event) => {
            // this press reaches nothing else; passEscapeOn sends it again
            event.preventDefault()
            event.stopPropagation()
            if (open) setEscaped(true)
            setOpen(false)
            passEscapeOn(event.target, contentRef.current)
          }}
        >
          {content}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

export { HoverTooltip, LiveTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
