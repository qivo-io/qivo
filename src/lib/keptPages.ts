/* The main pages that stay loaded, hidden, while another page shows
   (components/KeptView.tsx): every page the person opened, so going back
   to one shows it as it was. The Overview, the Board and the Roadmap show
   one scope, and a new scope, or a scope that is gone, ends them. The
   Inbox, Team sync and Projects show the same whatever the scope, so they
   stay. Settings is not one of them: it goes when the person leaves it,
   and the main pages stay loaded while it shows. */

/** How long the person may leave the app alone before every kept page
    but the one shown goes (releasePages): 30 minutes. */
export const KEEP_IDLE_MS = 30 * 60_000

/** The main pages, as App names the page it shows. */
export const MAIN_PAGES = ['inbox', 'projects', 'sync', 'overview', 'roadmap', 'kanban'] as const
export type MainPage = (typeof MAIN_PAGES)[number]

const SCOPE_PAGES: readonly MainPage[] = ['overview', 'roadmap', 'kanban']

/** Whether `page` shows one scope. */
export const showsScope = (page: MainPage) => SCOPE_PAGES.includes(page)

/** The pages kept, in the order they opened, and the scope of those that
    show one. */
export type KeptPages = { scope: string | null; pages: readonly MainPage[] }

export const NO_PAGES: KeptPages = { scope: null, pages: [] }

/** The pages kept after `kept` while `shown` shows in `scope` (null in
    Settings): the shown page joins them, and a new scope, or one that is
    gone (`scopeLive` false), ends the pages that showed the old one.
    Answers `kept` itself when nothing changed. */
export function keptPages({
  kept,
  scope,
  scopeLive,
  shown,
}: {
  kept: KeptPages
  scope: string | null
  scopeLive: boolean
  shown: MainPage | null
}): KeptPages {
  const live = scopeLive ? scope : null
  const pages = kept.pages.filter((page) => !showsScope(page) || kept.scope === live)
  // a page of a scope that is gone shows nothing, so it is not kept
  if (shown && !pages.includes(shown) && (live || !showsScope(shown))) pages.push(shown)
  return live === kept.scope && pages.length === kept.pages.length ? kept : { scope: live, pages }
}

/** What stays once the person has been away from the app for a while:
    only `shown`, the page on screen, if it is kept. */
export function releasePages(kept: KeptPages, shown: MainPage | null): KeptPages {
  const pages = kept.pages.filter((page) => page === shown)
  return pages.length === kept.pages.length ? kept : { ...kept, pages }
}
