/** The most labels the task window's label picker gathers with Load more
    (`labels`, eight batches of 25, as the relation pickers' PICKER_MOST,
    panels/LabelPicker.tsx), and the most people the editor's @ mention
    popup gathers (`mentions`, eight batches of 8,
    components/mentionSuggestion.ts); past either the list asks for more
    typing. Tests lower them and put them back. */
export const PICKER_CAPS = { labels: 200, mentions: 64 }
