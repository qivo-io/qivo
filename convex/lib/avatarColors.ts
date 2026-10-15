/* The avatar color palette. A new seat takes the entry at its roster position,
 * in the app's add-user flow and in the platform operator's organization setup
 * (adminOrgs.ts). Hex on purpose, not tokens. The color is DATA, written to
 * profiles.color and read back by every client, so a var() would be stored as
 * a string no other client could resolve. The server stores only #rrggbb
 * values (model/people.ts avatarColor), and a test keeps every entry valid. */
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
