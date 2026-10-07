import { Command as CommandPrimitive } from 'cmdk'
import { SearchIcon } from 'lucide-react'
import type * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { commandSearchFilter } from '@/lib/search'
import { cn } from '@/lib/utils'

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      filter={commandSearchFilter}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = true,
  shouldFilter,
  onOpenAutoFocus,
  onCloseAutoFocus,
  overlayClassName,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  shouldFilter?: React.ComponentProps<typeof CommandPrimitive>['shouldFilter']
  onOpenAutoFocus?: React.ComponentProps<typeof DialogContent>['onOpenAutoFocus']
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>['onCloseAutoFocus']
  overlayClassName?: string
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn('overflow-hidden p-0', className)}
        showCloseButton={showCloseButton}
        overlayClassName={overlayClassName}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          // Close this dialog without dismissing the page underneath it.
          event.stopPropagation()
        }}
      >
        <Command shouldFilter={shouldFilter} className="bg-inherit">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  endAdornment,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & { endAdornment?: React.ReactNode }) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2 border-b px-5 py-2">
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-control w-full rounded-none bg-transparent py-0 text-base !outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
        onKeyDown={(event) => {
          onKeyDown?.(event)
          // Keep native caret movement/selection instead of cmdk's result jumps.
          if (event.key === 'Home' || event.key === 'End') event.stopPropagation()
        }}
      />
      {endAdornment}
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto', className)}
      {...props}
    />
  )
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-0 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 min-h-8 rounded-sm px-2 py-1 text-base outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
}
