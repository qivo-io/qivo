/** The most labels the task window's label picker gathers with Load more
    (`labels`, eight batches of 25, as the relation pickers' PICKER_MOST,
    panels/LabelPicker.tsx), the most people the editor's @ mention popup
    gathers (`mentions`, eight batches of 8,
    components/mentionSuggestion.ts), and the most people a task's owner
    list (`owners`, components/AssigneeAvatar.tsx OwnerPickList, behind the
    task window's Assignee and Reviewer and every owner portrait) and Team
    sync's Mention window (`recipients`, views/teamSync/SyncCard.tsx
    MentionCtl) gather, twenty batches of 25. The owner and recipient
    lists keep 500, as the removal window's Reassign picker
    (panels/Modals.tsx TAKERS_MOST) and the other people pickers
    (lib/accessCaps.ts) do, rather than the label and relation pickers'
    200, since they list people, as Reassign lists people to take a task.
    Past any of them the list asks for more typing. Tests lower them and
    put them back. */
export const PICKER_CAPS = { labels: 200, mentions: 64, owners: 500, recipients: 500 }
