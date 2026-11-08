/* The avatar color palette. The app's add-user flow takes the entry its hash of
 * the new id picks (src/lib/labelColors.ts avatarColorFor), and the platform
 * operator's organization setup (adminOrgs.ts) the entry at the seat's roster
 * position. Hex on purpose, not tokens. The color is DATA, written to
 * profiles.color and read back by every client, so a var() would be stored as
 * a string no other client could resolve. The server stores only #rrggbb
 * values (model/people.ts avatarColor), and a test keeps every entry valid.
 * What a read sends for an older value (shownAvatarColor) is here too, free of
 * server runtime, so the stand-ins of the server send what it sends. */
export const AVATAR_COLORS = [
  '#0F766E',
  '#B45309',
  '#1D4ED8',
  '#6D28D9',
  '#9333EA',
  '#0891B2',
  '#BE123C',
  '#4D7C0F',
  '#A16207',
  '#0E7490',
] as const

/** The gray a read sends in place of a stored color that breaks the rule. */
const FALLBACK_AVATAR_COLOR = '#8A8F98'

/** The color to send a client. Seats created before the `#rrggbb` rule may
 * hold any text, so every read that hands a profile to a client uses this and
 * sends gray instead. The stored value stays as it is. */
export function shownAvatarColor(stored: string): string {
  return /^#[0-9a-f]{6}$/i.test(stored) ? stored : FALLBACK_AVATAR_COLOR
}
