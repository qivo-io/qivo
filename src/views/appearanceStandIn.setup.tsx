import type { ReactNode } from 'react'

/** The account's appearance as the app's provider hands it on, with Hide
    Done in Roadmap as `hide`, on as the server answers it for an account
    that never turned it off, or null before the account's appearance
    loads. `context` is the module a view imported after loadBoard's reset,
    so the view reads this. */
export function Appearance({
  context,
  hide = true,
  children,
}: {
  context: typeof import('../lib/appearanceContext')
  hide?: boolean | null
  children: ReactNode
}) {
  const base = context.useAppearance()
  const preferences =
    hide === null
      ? null
      : {
          mode: 'dark' as const,
          image_source: 'none' as const,
          roadmap_hide_done: hide,
          custom_image: null,
        }
  return (
    <context.AppearanceContext.Provider
      value={{ ...base, preferences, preferencesState: preferences ? 'ok' : 'loading' }}
    >
      {children}
    </context.AppearanceContext.Provider>
  )
}
