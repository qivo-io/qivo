import { type ComponentType, createElement, lazy, useRef } from 'react'

/** Share an import with boot preloading and retain its resolved module. */
export function preloadModule<Module extends object>(importModule: () => Promise<Module>) {
  let loaded: Module | undefined
  let pending: Promise<Module> | undefined
  const load = () => {
    pending ??= importModule().then(
      (module) => {
        loaded = module
        return module
      },
      (error: unknown) => {
        pending = undefined
        throw error
      },
    )
    return pending
  }
  return Object.assign(load, { peek: () => loaded })
}

/** A preloaded view renders without a Suspense fallback. Keep its component
 * type stable for the mounted lifetime so later renders preserve drafts. */
export function lazyFromModule<Module extends object, Props extends object>(
  load: ReturnType<typeof preloadModule<Module>>,
  select: (module: Module) => ComponentType<Props>,
) {
  const Lazy = lazy(() => load().then((module) => ({ default: select(module) })))
  return function Deferred(props: Props) {
    const loaded = load.peek()
    const component = useRef(loaded ? select(loaded) : Lazy)
    return createElement(component.current, props)
  }
}
