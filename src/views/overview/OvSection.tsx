import type { ReactNode } from 'react'

export function OvSection({
  title,
  action,
  children,
}: {
  title: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="overview-section">
      <div className="overview-section-body">
        <div className="overview-section-heading [display:flex] [align-items:center] [min-height:32px] [gap:8px] [margin-bottom:8px]">
          <h2 className="m-0 text-md font-semibold text-text-1">{title}</h2>
          {action && (
            <>
              <div className="[flex:1]" />
              {action}
            </>
          )}
        </div>
        {children}
      </div>
      <div className="overview-section-foot" aria-hidden="true" />
    </section>
  )
}
