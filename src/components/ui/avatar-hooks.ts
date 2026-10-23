import { cn } from '@/lib/utils'

/** The data hooks and class Avatar gives its root, before its props.
    rowElements.tsx spreads them on a static row's span of its own. */
export const avatarHooks = (size: string, className?: string) => ({
  'data-slot': 'avatar',
  'data-size': size,
  className: cn(
    'group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none data-[size=lg]:size-10 data-[size=sm]:size-6',
    className,
  ),
})
