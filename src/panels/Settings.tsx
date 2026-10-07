/* Settings navigation, access redirects and page composition. */
import { useEffect as useEffectS } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from '../components/qivo'
import { WorkspacePageHeader, WorkspaceShell } from '../components/WorkspaceShell'
import { useMobile } from '../lib/useMobile'
import { P } from '../store/planner'
import { BillingSettings } from './BillingSettings'
import '../styles/settings-layout.css'
import '../styles/mobile-settings.css'
import { AccountPage } from './settings/AccountSettings'
import { OrgLabelsPage } from './settings/LabelsSettings'
import { OrgGeneralPage } from './settings/OrganizationSettings'
import { ArchivedProjectsPage, OrgProjectsPage, ProjectPage } from './settings/ProjectSettings'
import { OrgTeamsPage, TeamPage } from './settings/TeamSettings'
import { OrgUsersPage } from './settings/UsersSettings'

function SettingsScreen({
  page,
  setPage,
  onBackPage = setPage,
  onExit,
  onNewProject,
  onNewSubProject,
  onOpenArchive,
  onProjectGone,
}: {
  page: string
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
  onExit: () => void
  onNewProject: () => void
  onNewSubProject: (parent: string) => void
  onOpenArchive: (projectId: string) => void
  onProjectGone?: (parent: string | null) => void
}) {
  const narrow = useMobile()
  const admin = P.isAdmin()
  // Only home-organization team leaders and admins can open team settings.
  const myTeams = P.teams.filter((t) => t.org === P.homeOrg && P.isTeamLeader(t.id))

  useEffectS(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onExit()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onExit])

  // The phone menu is an entry point, not a new desktop settings page.
  useEffectS(() => {
    if (!narrow && page === 'menu') setPage('account')
  }, [narrow, page, setPage])

  // keep the page valid for the current user
  useEffectS(() => {
    if (page.indexOf('project:') === 0) {
      const pid = page.slice(8)
      const pr = P.project(pid)
      const meta = pr ? (pr.type === 'meta' ? pr : P.project(pr.parent)) : null
      if (!(meta && P.canSee(meta.id))) setPage('account')
    } else if (page.indexOf('team:') === 0) {
      if (!P.isTeamLeader(page.slice(5))) setPage('account')
    } else if (page.startsWith('user:')) {
      if (!admin) setPage('account')
      else if (!P.homeUsers().some((user) => user.id === page.slice(5))) setPage('org-users')
    } else if (page === 'org-teams') {
      // the one org- page a team leader reaches without being an admin
      if (!admin && !myTeams.length) setPage('account')
    } else if (page.indexOf('org-') === 0 && !admin) {
      setPage('account')
    }
  })

  // Organization settings belong to the home organization. Projects can span
  // organizations, so their navigation remains outside that group.
  // Personal settings come first in both the desktop rail and the phone menu.
  const groups = [
    {
      label: 'User account',
      items: [{ id: 'account', label: 'Your preferences', icon: 'user' }],
    },
  ]
  const orgItems = []
  if (admin)
    orgItems.push(
      { id: 'org-general', label: 'General', icon: 'cog' },
      { id: 'org-billing', label: 'Billing', icon: 'chart' },
      { id: 'org-users', label: 'Users', icon: 'people' },
    )
  // a team leader manages their own team without being an org admin
  if (admin || myTeams.length) orgItems.push({ id: 'org-teams', label: 'Teams', icon: 'layers' })
  if (admin) orgItems.push({ id: 'org-labels', label: 'Labels', icon: 'tag' })
  if (orgItems.length) groups.push({ label: 'Organization', items: orgItems })
  groups.push({
    label: 'Projects',
    items: [
      { id: 'projects', label: 'All projects', icon: 'layers' },
      // Keep the archive discoverable even when empty.
      { id: 'projects-archived', label: 'Archived projects', icon: 'archive' },
    ],
  })
  let content = null
  if (page === 'account' || page.startsWith('account-'))
    content = (
      <AccountPage
        narrow={narrow}
        section={page.slice(8)}
        setPage={setPage}
        onBackPage={onBackPage}
      />
    )
  else if (page === 'projects')
    content = (
      <OrgProjectsPage
        setPage={setPage}
        onNewProject={onNewProject}
        onNewSubProject={onNewSubProject}
        onOpenArchive={onOpenArchive}
      />
    )
  else if (page === 'projects-archived') content = <ArchivedProjectsPage />
  else if (page === 'org-general') content = <OrgGeneralPage />
  else if (page === 'org-billing') content = <BillingSettings />
  else if (page === 'org-users' || page.startsWith('user:'))
    content = (
      <OrgUsersPage
        narrow={narrow}
        userId={page.slice(5)}
        setPage={setPage}
        onBackPage={onBackPage}
      />
    )
  else if (page === 'org-teams') content = <OrgTeamsPage setPage={setPage} />
  else if (page === 'org-labels') content = <OrgLabelsPage />
  else if (page.indexOf('team:') === 0)
    content = <TeamPage teamId={page.slice(5)} setPage={setPage} onBackPage={onBackPage} />
  else if (page.indexOf('project:') === 0)
    content = (
      <ProjectPage
        projectId={page.slice(8)}
        setPage={setPage}
        onBackPage={onBackPage}
        onProjectGone={onProjectGone}
      />
    )

  const navigation = (
    <aside className="settings-navigation" aria-label="Settings navigation">
      {!narrow && (
        <div className="[flex-shrink:0] [padding:8px_12px]">
          <Button
            type="button"
            variant="ghost"
            onClick={onExit}
            data-settings-back
            title="Back to the planner (esc)"
            className="w-full justify-start"
          >
            <Icon name="chevronRight" size={16} className="[transform:rotate(180deg)]" />
            Back
          </Button>
        </div>
      )}
      <div className="settings-nav-scroll">
        {groups.map((g) => (
          <div key={g.label} className="[margin-bottom:24px]">
            <div className="[font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-2)] [padding:0_8px_8px]">
              {g.label}
            </div>
            <div className="[display:flex] [flex-direction:column] [gap:1px]">
              {g.items.map((item) => {
                // Detail pages keep their parent list selected.
                const active =
                  page === item.id ||
                  (item.id === 'account' && page.startsWith('account-')) ||
                  (item.id === 'org-users' && page.startsWith('user:')) ||
                  (item.id === 'org-teams' && page.indexOf('team:') === 0) ||
                  (item.id === 'projects' && page.indexOf('project:') === 0)
                return (
                  <Button
                    type="button"
                    key={item.id}
                    data-settings-item={item.id}
                    data-on={active ? '' : undefined}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setPage(item.id)}
                    // a quiet row lit by `data-on`, like every other "you are
                    // here" control (deviation #232)
                    variant="quiet"
                    className="w-full justify-start gap-2 rounded-sm px-2 text-base"
                  >
                    <Icon name={item.icon} size={16} />
                    <span className="[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                      {item.label}
                    </span>
                    <Icon name="chevronRight" size={16} className="settings-menu-chevron" />
                  </Button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
  const isMenu = narrow && page === 'menu'
  // This parent control lives outside the reading pane. A long roster or
  // Manage people jump must never scroll away the way back to its parent.
  const mobileParent = (() => {
    if (page === 'menu') return { page: null, label: 'planner' }
    if (page.startsWith('account-')) return { page: 'account', label: 'preferences' }
    if (page.startsWith('user:')) return { page: 'org-users', label: 'Users' }
    if (page.startsWith('team:')) return { page: 'org-teams', label: 'Teams' }
    if (page.startsWith('project:')) {
      const project = P.project(page.slice(8))
      const parent = project?.parent ? P.project(project.parent) : null
      return parent
        ? { page: `project:${parent.id}`, label: parent.name }
        : { page: 'projects', label: 'Projects' }
    }
    return { page: 'menu', label: 'settings' }
  })()
  return (
    <WorkspaceShell
      className="settings-shell"
      header={
        narrow ? (
          <header className="settings-mobile-header">
            <Button
              type="button"
              variant="ghost"
              data-settings-back
              className="settings-mobile-header-back"
              aria-label={`Back to ${mobileParent.label}`}
              title={`Back to ${mobileParent.label}`}
              onClick={() => (mobileParent.page ? onBackPage(mobileParent.page) : onExit())}
            >
              <Icon name="chevronLeft" size={16} />
              Back
            </Button>
            <h1>Settings</h1>
          </header>
        ) : (
          <WorkspacePageHeader label="Settings" icon="cog" />
        )
      }
    >
      {!narrow && navigation}
      <main data-screen-label="Settings" className="settings-main">
        <div className="settings-content-frame">
          <div key={page} data-settings-page={page} className="settings-content-scroll">
            {isMenu ? navigation : content}
          </div>
        </div>
      </main>
    </WorkspaceShell>
  )
}

export { SettingsScreen }
