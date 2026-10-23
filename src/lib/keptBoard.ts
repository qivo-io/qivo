/** The scope whose Board stays loaded (components/KeptView.tsx), from the
    one kept before: the scope, once its Board has shown, for as long as
    the scope lasts. Every other page of the scope keeps it (the Overview,
    the Roadmap, the Inbox, Team sync, Projects and Settings); a new scope,
    or a scope that is gone, drops it. */
export function keptBoardScope({
  kept,
  scope,
  scopeLive,
  boardShown,
}: {
  kept: string | null
  scope: string | null
  scopeLive: boolean
  boardShown: boolean
}) {
  if (!scope || !scopeLive) return null
  return boardShown || kept === scope ? scope : null
}
