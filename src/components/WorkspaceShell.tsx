import { createContext, type ReactNode, useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './qivo'

const ToolbarHost = createContext<HTMLElement | null>(null)

/** Controls retain their view's state while sharing a row above both panels. */
export function WorkspaceToolbar({ children }: { children: ReactNode }) {
  const host = useContext(ToolbarHost)
  return host ? createPortal(children, host) : null
}

export function WorkspaceShell({
  className = '',
  header,
  navigation,
  children,
}: {
  className?: string
  header: ReactNode
  navigation?: ReactNode
  children: ReactNode
}) {
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  return (
    <ToolbarHost.Provider value={toolbarHost}>
      <div className={`workspace-shell ${className}`}>
        <div className="workspace-header">{header}</div>
        <div className="workspace-toolbar" ref={setToolbarHost} />
        {navigation}
        {children}
      </div>
    </ToolbarHost.Provider>
  )
}

export function WorkspaceHeader({
  left,
  actions,
  children,
}: {
  left?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <header className="planner-topbar">
      <div className="planner-view-row">
        <div className="workspace-header-context" data-scope-crumb>
          {left}
        </div>
        <div className="workspace-header-center">{children}</div>
        <div className="workspace-header-actions">{actions}</div>
      </div>
    </header>
  )
}

/** A single current page is a heading, with the same well as the view selector. */
export function WorkspacePageHeader({
  label,
  icon,
  left,
  actions,
}: {
  label: string
  icon: string
  left?: ReactNode
  actions?: ReactNode
}) {
  return (
    <WorkspaceHeader left={left} actions={actions}>
      <div data-view-switch data-page-header={label}>
        <div className="workspace-page-pill">
          <h1 className="workspace-page-current">
            <Icon name={icon} size={16} />
            {label}
          </h1>
        </div>
      </div>
    </WorkspaceHeader>
  )
}
