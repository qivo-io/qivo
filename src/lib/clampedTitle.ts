/** The tooltip of a task title a surface clamps to four lines (LIMITS.title
    allows 255 characters). A title of up to 80 characters fits four lines of
    the narrowest board column, so only a longer one gets its whole text in a
    tooltip. */
export const clampedTitleTip = (title: string): string | undefined =>
  title.length > 80 ? title : undefined
