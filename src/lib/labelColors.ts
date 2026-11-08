/* The label color palette for new labels and the Labels settings swatches.
 * Hex on purpose, not tokens. A picked color is DATA, written to labels.color
 * and read back by every client, so a var() would be stored as a string no
 * other client could resolve. Do not "migrate" these to tokens. The server
 * stores only #rrggbb values (convex/model/labels.ts), and a test keeps every
 * entry valid. */
import { AVATAR_COLORS } from '../../convex/lib/avatarColors'

export const LABEL_COLORS = [
  { color: '#6D7BF2', name: 'Indigo' },
  { color: '#F0555D', name: 'Red' },
  { color: '#2FBE7A', name: 'Green' },
  { color: '#F2994A', name: 'Orange' },
  { color: '#A78BFA', name: 'Purple' },
  { color: '#4C9AFF', name: 'Blue' },
  { color: '#E3C55A', name: 'Yellow' },
  { color: '#0891B2', name: 'Teal' },
  { color: '#BE123C', name: 'Rose' },
  { color: '#8A8F98', name: 'Gray' },
] as const

/** A fixed hash (FNV-1a) of `id`'s characters onto `size` places, so the
    same id always takes the same place and new ids spread over them. */
function slotOf(id: string, size: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % size
}

/** The palette color of a new label `id`: a fixed hash (FNV-1a) of the
    id's characters onto LABEL_COLORS, so the same id always takes the
    same color, new labels spread over the whole palette, and the choice
    needs no catalogue of the organization's labels. */
export function labelColorFor(id: string): string {
  return LABEL_COLORS[slotOf(id, LABEL_COLORS.length)].color
}

/** The portrait color of a new person `id` (store/planner.ts P.addUser):
    the same hash onto the shared avatar palette, which holds only colors
    the server stores, so it needs no count of the organization's people. */
export function avatarColorFor(id: string): string {
  return AVATAR_COLORS[slotOf(id, AVATAR_COLORS.length)]
}
