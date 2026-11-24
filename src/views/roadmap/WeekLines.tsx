/** A line on the left edge of each week of `w0`..`w1` after the first, in a
    positioned box that starts at the first week: solid where `monthStarts`
    opens a month, dashed elsewhere. The timeline's rows and Team
    utilization both draw these, so their lines stay on the same pixels. */
export function WeekLines({
  w0,
  w1,
  weekW,
  monthStarts,
}: {
  w0: number
  w1: number
  weekW: number
  monthStarts: ReadonlySet<number>
}) {
  return (
    <>
      {Array.from({ length: w1 - w0 }, (_, i) => {
        // keyed on the week the line stands on, as the week band's cells are
        const w = w0 + i + 1
        return monthStarts.has(w) ? (
          <div
            key={w}
            style={{ left: (i + 1) * weekW }}
            className="[position:absolute] [top:0] [bottom:0] [width:1px] [background:var(--border-strong)]"
          />
        ) : (
          <div
            key={w}
            style={{ left: (i + 1) * weekW }}
            className="[position:absolute] [top:0] [bottom:0] [width:0] [border-left:1px_dashed_var(--border)] [opacity:0.6]"
          />
        )
      })}
    </>
  )
}
