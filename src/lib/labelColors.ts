/* The label color palette for new labels and the Labels settings swatches.
 * Hex on purpose, not tokens. A picked color is DATA, written to labels.color
 * and read back by every client, so a var() would be stored as a string no
 * other client could resolve. Do not "migrate" these to tokens. The server
 * stores only #rrggbb values (convex/model/labels.ts), and a test keeps every
 * entry valid. */
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
