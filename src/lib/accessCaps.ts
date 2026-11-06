/** The most rows each of a project's access lists gathers with Load more,
    eight live batches, and the most choices one of its pickers gathers
    (components/ProjectAccessEditor.tsx), as do the New project and New
    sub-project dialogs' Project access, Project and Lead lists; past
    either a search narrows the list. Tests lower them and put them back. */
export const ACCESS_CAPS = { list: 200, choices: 500 }

/** The most rows Settings › Teams (`teams`) and a team's member list
    (`members`) gather with Load more, eight live batches, and the most
    choices its Add member picker gathers (panels/settings/TeamSettings.tsx);
    past either a search narrows the list. Tests lower them and put them
    back. */
export const TEAM_CAPS = { teams: 200, members: 200, choices: 500 }
