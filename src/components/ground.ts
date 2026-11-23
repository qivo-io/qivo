/* Where the row stands decides what a control looks like at rest (deviation
   #232): inside a well — the Board and Roadmap toolbars and All projects'
   row — it is quiet and draws nothing until hovered; on a page — the
   phone's filter sheet and Projects page — it keeps a border. Lit is the
   same everywhere: the raised chip `data-on` / a pressed toggle paints. */
export type Ground = 'well' | 'page'
export const menuVariant = (ground: Ground) => (ground === 'well' ? 'quiet' : 'default')
export const toggleVariant = (ground: Ground) => (ground === 'well' ? 'quiet' : 'outline')
/* a well's controls take the tighter radius its own corners leave room for */
export const groundRadius = (ground: Ground) => (ground === 'well' ? 'rounded-sm' : 'rounded-md')
