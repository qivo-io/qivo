/** The longest title that always fits the four lines a surface clamps a
    title to. A subtask row in the narrowest Board column (220 px, 66 px of
    it chrome) holds about 19 characters a line at the 8 px a title
    character takes with its share of word wrapping (lib/boardGroups.ts),
    and a line can break early before a long word, so 50 leaves room. */
const ALWAYS_FITS = 50

/** The tooltip of a task title a surface clamps to four lines (LIMITS.title
    allows 255 characters): its whole text for a title that may be cut, and
    nothing for one that always fits. */
export const clampedTitleTip = (title: string): string | undefined =>
  title.length > ALWAYS_FITS ? title : undefined
