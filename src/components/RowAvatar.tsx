/* The portrait of a person a list's own answer names (the follower
   popover's rows, the view filter's Assignee menu), drawn from the row's
   initials and color, so the list loads no one's face to show them. Where
   the store's profile cache holds the person's picture, as for a person an
   open view names, the picture shows over the initials. A list that names
   its rows (components/usePeople.ts) marks them `named`, which the audit of
   named portraits reads (src/peopleNamed.test.tsx data-avatar); the rest
   carry data-row-avatar. */

import { cn } from '@/lib/utils'
import { P } from '@/store/planner'
import type { AvatarSize } from './rowElements'

/** What a row gives its portrait: the person's id, name, initials and the
    portrait's color as the server sends it. */
export type PortraitRow = { id: string; name: string; initials: string; color: string }

/** Row `row`'s portrait in organization `org`, `size` pixels square. */
export function RowAvatar({
  row,
  org,
  size = 28,
  named = false,
}: {
  row: PortraitRow
  org: string
  size?: AvatarSize
  named?: boolean
}) {
  const person = P.person(row.id, org)
  const picture = person?.state === 'ok' ? person.picture : null
  return (
    <span
      {...(named ? { 'data-avatar': row.id } : { 'data-row-avatar': row.id })}
      role="img"
      aria-label={row.name}
      style={{ width: size, height: size, backgroundColor: row.color }}
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-[5px] font-semibold text-white',
        size === 20 ? 'rounded-[4px] text-[10px]' : '[font-size:var(--fs-sm)]',
      )}
    >
      {row.initials}
      {picture && (
        // no-referrer so the page a face is drawn on never reaches the host
        <img
          key={picture}
          data-avatar-img
          src={picture}
          alt=""
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
          className="[position:absolute] [inset:0] [width:100%] [height:100%] [object-fit:cover] [display:block] [border-radius:inherit]"
        />
      )}
    </span>
  )
}
