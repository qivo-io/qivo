/* @-mention suggestions for the description and comment editors. Typing "@"
   opens a list of the people who have access to the project of the
   editor's task, by name alone, anchored under the caret (the suggestion plugin's managed mount handles positioning and
   outside-click dismissal; Escape is handled by the plugin itself, which
   exits the suggestion without bubbling to the modal). Selecting inserts a
   mention node {id, label}, which the dialect stores as
   @[Name](user:<uuid>), the byte pattern the server's notify triggers
   parse.

   The people come from the server, 8 at a time in name order
   (pickers.mentions, through P.mentionChoices), never from the workspace's
   roster. The server offers the active people and agents who see the
   task's project, the caller too, and searches them with the popup's
   match: every word of the text in the name or the initials, in any
   order, ignoring case but not accents. It sends no email, and a row
   shows the name alone, for everyone (the owner's decision of 12 November
   2026). An editor that names no task reads nothing and lists nobody,
   and a read for the person's own new task waits until the server took
   its create.
   The renderer reads
   through the shared paged list's `once` engine (lib/pagedList.ts
   onceList), so TipTap's own fetch (`items`) answers nothing and can never
   fail, which TipTap would show as no match:

   - Typing rests MENTION_DELAY_MS before a read, and a text whose words
     did not change reads nothing. A new text drops every older text's
     answer, and Load more and Try again read nothing while a read runs. A
     text whose words (searchWords, what the read sends) pass LIMITS.search
     reads nothing and says so. The limit reads the words the list is keyed
     by, so whitespace alone never makes a text too long, and a text is
     never too long once and readable the next time under the same key.
   - While the answer for the typed text is on its way, the last answer's
     rows stay, dimmed and not pressable, above "Searching…", so the list
     does not flicker and no row of an older text can be picked. An Enter
     or Tab pressed then is kept for that text and picks the first row of
     its answer once it arrives; it is forgotten when the text changes
     first or the answer holds nobody. Arrow keys wait for the answer.
   - Load more is the last row while more people follow and fewer than
     PICKER_CAPS.mentions are kept, reachable with the arrow keys and
     Enter and by a press that keeps the editor's focus. The highlight
     moves to the first new row when its batch lands. After a failed read
     Try again is the last row in its place, reached and pressed the same
     way, and a retried Load more moves the highlight as Load more does.
   - The list tells a search on its way, names not ready, a refusal with
     the server's sentence, a failure with Try again, a stopped batch and
     the cap apart, and says "No matching members" only at the list's real
     end. A text that starts with one whose list ended with nobody matches
     nobody too (convex/lib/search.ts searchWords), so it says so without
     a read.
   - Leaving stops the reads and the timer, so a late answer changes
     nothing, and nothing is kept between popups. TipTap calls `render`
     once for each editor and opens every popup of it on that one
     renderer (@tiptap/suggestion suggestion.ts), so each popup starts
     from `reset`. The next "@" reads again, also for the words the last
     popup ended on, and asks again for a text that matched nobody.

   Plain DOM, no React: the popup is a transient list rebuilt on each
   change, which keeps this out of the editor's render cycle entirely. */
import type { MentionNodeAttrs } from '@tiptap/extension-mention'
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'
import { LIMITS } from '../../convex/lib/limits'
import { searchWords } from '../../convex/lib/search'
import { limitSentence, overLimit } from '../lib/fieldLimits'
import { listEnd, onceList } from '../lib/pagedList'
import { PICKER_CAPS } from '../lib/pickerCaps'
import { type MentionChoice, type MentionChoices, P } from '../store/planner'
import { MENTION_WORDS } from './pickerWords'

/** How long typing rests before the popup reads. Shorter than a picker's
    search box (lib/pagedList.ts SEARCH_DELAY_MS), since the popup has no
    box of its own and answered every keystroke at once while it filtered
    the workspace's roster. */
export const MENTION_DELAY_MS = 150

/** The most texts that matched nobody one popup remembers. */
const NONE_KEPT = 32

/* How many popups were made, which names each one's key for the people it
   names (P.namePeople). */
let popups = 0

/** What the popup shows now: its state (`data-mention-state`), its rows,
    whether they are an older text's (`stale`), the lines under them, and
    the action after the lines, which the keys reach after the rows: Load
    more, Load more while its batch reads (`loading`), or Try again after a
    failed read (`retry`). */
type Shown = {
  state: 'loading' | 'stale' | 'ok' | 'held' | 'failed'
  rows: readonly MentionChoice[]
  stale: boolean
  lines: string[]
  action: 'more' | 'loading' | 'retry' | null
}

export const mentionSuggestion: Omit<
  SuggestionOptions<MentionChoice, MentionNodeAttrs>,
  'editor'
> = {
  char: '@',
  allowSpaces: true,
  // the renderer reads the people itself (above), so TipTap fetches nothing
  items: () => [],

  render: () => {
    let el: HTMLDivElement | null = null
    let unmount: (() => void) | null = null
    let command: (attrs: MentionNodeAttrs) => void = () => {}
    // the editor's organization, the task's, else the home organization,
    // and the task its text belongs to, by uuid, or '' when it names none
    let org = ''
    let task = ''
    // the typed text as the match reads it, and its list's key
    let words = ''
    let typedKey: string | null = null
    let tooLong = false
    // the list the engine has open, and its words
    let openKey: string | null = null
    let openWords = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    // the keys of texts whose lists ended with nobody
    const none = new Set<string>()
    // the rows of the last answer, shown dimmed while the next is on its way
    let lastRows: readonly MentionChoice[] = []
    let selected = 0
    // the key an Enter or Tab was pressed for while its answer was on its way
    let enterFor: string | null = null
    // how many rows a Load more started from, so the highlight moves to
    // the first new one
    let moreFrom: number | null = null
    // the key this popup names its people under, the pictures its rows
    // showed at the last build, and the way to stop hearing the store
    const owner = `mention:${++popups}`
    let pictures = ''
    let stopWatch: (() => void) | null = null
    // the reads that wait for the task's create, each by the way to end it
    const waits = new Set<() => void>()

    const list = onceList<MentionChoices, MentionChoice>(
      () => ({
        key: openKey,
        source: {
          kind: 'once',
          read: (at): Promise<MentionChoices | null> => {
            if (task === '') return Promise.resolve({ state: 'unavailable' })
            const words = openWords
            const read = () => P.mentionChoices({ org, task }, words, at.after)
            // the server cannot read a task it does not hold yet
            return P.createOnItsWay(task) ? created(task).then(read) : read()
          },
        },
        batch: (answer) => (answer.state === 'ready' ? answer : null),
        id: (row) => row.id,
        most: PICKER_CAPS.mentions,
      }),
      () => landed(),
    )

    /** Resolves once the server took `task`'s create (P.createOnItsWay).
        The popup says Searching… meanwhile, as for any answer on its way,
        and lists the task's people once it is saved. A wait that
        `dropWaits` ended never resolves, so a text that was replaced and
        a popup that closed read nothing. */
    function created(task: string): Promise<void> {
      return new Promise((resolve) => {
        const end = () => {
          stop()
          waits.delete(end)
        }
        const stop = P.subscribe(() => {
          if (P.createOnItsWay(task)) return
          end()
          resolve()
        })
        waits.add(end)
      })
    }

    /** Ends every wait for a create, as a new text and leaving do. */
    function dropWaits() {
      for (const end of waits) end()
    }

    /** Whether the typed text is known to match nobody without a read. */
    const knownNone = () =>
      words !== '' && typedKey !== null && [...none].some((key) => typedKey?.startsWith(key))

    /** Whether the list on screen answers the typed text. */
    const answered = () =>
      typedKey !== null && openKey === typedKey && list.view().phase !== 'first'

    const pick = (u: MentionChoice) => command({ id: u.id, label: u.name })

    /** What the popup shows now (Shown). */
    function current(): Shown {
      const empty = { rows: [], stale: false, action: null }
      if (tooLong) return { ...empty, state: 'held', lines: [limitSentence(LIMITS.search)] }
      if (knownNone() && !answered()) return { ...empty, state: 'ok', lines: [MENTION_WORDS.none] }
      if (!answered())
        return {
          state: lastRows.length > 0 ? 'stale' : 'loading',
          rows: lastRows,
          stale: true,
          action: null,
          lines: [MENTION_WORDS.searching],
        }
      const view = list.view()
      const end = listEnd(view, words !== '')
      if (view.phase === 'held')
        return { ...empty, state: 'held', lines: [MENTION_WORDS.held(view.answers[0])] }
      if (view.phase === 'failed') {
        // a refusal gives the server's sentence, which another read repeats
        const why = view.failure ? MENTION_WORDS.held(view.failure) : null
        const text =
          why ?? (view.rows.length === 0 ? MENTION_WORDS.failed : MENTION_WORDS.failedMore)
        return {
          state: 'failed',
          rows: view.rows,
          stale: false,
          action: why === null ? 'retry' : null,
          lines: [text],
        }
      }
      const lines: string[] = []
      if (end === 'more' && view.stopped) lines.push(MENTION_WORDS.stopped)
      if (end === 'full') lines.push(MENTION_WORDS.full)
      if ((end === 'none' || end === 'end') && view.rows.length === 0)
        lines.push(MENTION_WORDS.none)
      return {
        state: 'ok',
        rows: view.rows,
        stale: false,
        action: end === 'more' ? (view.phase === 'more' ? 'loading' : 'more') : null,
        lines,
      }
    }

    /** The rows the keys move over: the people, then the action. */
    const itemCount = (shown: Shown) =>
      shown.stale ? 0 : shown.rows.length + (shown.action ? 1 : 0)

    /** Reads the next batch, unless one is on its way. */
    function more() {
      if (list.view().phase === 'more') return
      moreFrom = list.view().rows.length
      list.more()
    }

    /** Reads a failed batch again: the first, or a Load more's, whose batch
        then moves the highlight as Load more's does. */
    function retry() {
      const view = list.view()
      if (view.phase === 'failed' && view.rows.length > 0) moreFrom = view.rows.length
      list.retry()
    }

    /** Forgets everything a popup typed, read and was asked, so the next
        popup of this editor starts as the first did, and releases the
        people it named. */
    function reset() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      dropWaits()
      list.stop()
      P.namePeople(owner, [])
      pictures = ''
      words = ''
      typedKey = null
      tooLong = false
      openKey = null
      openWords = ''
      none.clear()
      lastRows = []
      selected = 0
      enterFor = null
      moreFrom = null
    }

    /** After the list changed: keeps its rows for the next text, remembers
        a text that matched nobody, moves the highlight past a Load more and
        acts on an Enter kept for this text. */
    function landed() {
      const view = list.view()
      if (view.phase === 'first' || openKey === null) return rebuild()
      lastRows = view.rows
      if (openWords !== '' && listEnd(view, true) === 'none') {
        none.add(openKey)
        for (const oldest of none) {
          if (none.size <= NONE_KEPT) break
          none.delete(oldest)
        }
      }
      if (moreFrom !== null && view.phase !== 'more') {
        if (view.rows.length > moreFrom) selected = moreFrom
        moreFrom = null
      }
      if (enterFor !== null && enterFor === openKey && view.phase !== 'more') {
        enterFor = null
        const first = view.rows[0]
        if (first) return pick(first)
      }
      rebuild()
    }

    /** Opens the list for the typed text, unless it is open already. */
    function openTyped() {
      timer = null
      if (typedKey === null || typedKey === openKey) return
      openKey = typedKey
      openWords = words
      selected = 0
      // a Load more of the text before has no place in this list
      moreFrom = null
      dropWaits()
      list.open(openKey)
    }

    /** Takes the text after "@" as typed now. A text with new words reads
        after MENTION_DELAY_MS, unless its words are too long or known to
        match nobody. */
    function update(query: string) {
      const nextWords = searchWords(query)
      const nextKey = `${org}\n${task}\n${nextWords}`
      if (nextKey !== typedKey) {
        typedKey = nextKey
        words = nextWords
        // the words the key holds and the read sends, so whether a text is
        // too long changes only with its key
        tooLong = overLimit(LIMITS.search, words)
        selected = 0
        if (enterFor !== null && enterFor !== typedKey) enterFor = null
        if (timer !== null) clearTimeout(timer)
        timer = null
        if (!tooLong && !knownNone() && typedKey !== openKey)
          timer = setTimeout(openTyped, MENTION_DELAY_MS)
      }
      rebuild()
    }

    /** A person's row; an older text's row is dimmed and takes no press. */
    function rowOf(u: MentionChoice, i: number, stale: boolean): HTMLButtonElement {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `mentionpop-row${!stale && i === selected ? ' active' : ''}`
      row.setAttribute('data-mention-option', u.name)
      row.setAttribute('data-mention-id', u.id)
      // this popup builds its own avatar in plain DOM, so it inherits
      // nothing from <Avatar>: the same layers are assembled by hand,
      // initials on the row's color, with the person's picture from the
      // store (P.person, the signed-in person's own profile or the profile
      // cache)
      // painted over them
      const av = document.createElement('span')
      av.className = 'mentionpop-av'
      av.style.background = u.color
      av.textContent = u.initials
      const src = pictureOf(u.id)
      if (src) {
        const img = document.createElement('img')
        img.src = src
        img.alt = ''
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('error', () => img.remove())
        av.appendChild(img)
      }
      const name = document.createElement('span')
      name.className = 'mentionpop-name'
      name.textContent = u.name
      row.append(av, name)
      // mousedown, not click: the editor must keep focus and selection
      if (stale) {
        row.setAttribute('data-mention-stale', '')
        row.setAttribute('aria-disabled', 'true')
        row.tabIndex = -1
        row.addEventListener('mousedown', (e) => e.preventDefault())
        return row
      }
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        pick(u)
      })
      // guard: rebuild() replaces the row under a stationary cursor, and
      // the fresh node fires mouseenter again; unguarded, that loops forever
      row.addEventListener('mouseenter', () => {
        if (selected !== i) {
          selected = i
          rebuild()
        }
      })
      return row
    }

    /** A button of the popup that keeps the editor's focus. */
    function actionOf(text: string, mark: string, act: () => void, active = false) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `mentionpop-row mentionpop-action${active ? ' active' : ''}`
      button.setAttribute(mark, '')
      button.textContent = text
      button.addEventListener('mousedown', (e) => {
        e.preventDefault()
        act()
      })
      return button
    }

    /** Person `id`'s picture as the store holds it now, or null. */
    function pictureOf(id: string): string | null {
      const person = P.person(id, org)
      return person?.state === 'ok' ? person.picture : null
    }

    function rebuild() {
      if (!el) return
      el.innerHTML = ''
      const shown = current()
      // the loaded rows' people, named while the popup is open, so the
      // store asks for their pictures in the rows' order
      P.namePeople(
        owner,
        shown.rows.map((u) => ({ org, id: u.id })),
      )
      pictures = shown.rows.map((u) => pictureOf(u.id) ?? '').join('\n')
      el.setAttribute('data-mention-state', shown.state)
      const count = itemCount(shown)
      if (selected >= count) selected = Math.max(0, count - 1)
      for (const [i, u] of shown.rows.entries()) el.appendChild(rowOf(u, i, shown.stale))
      for (const text of shown.lines) {
        const end = document.createElement('div')
        end.className = 'mentionpop-empty'
        end.setAttribute('data-mention-end', '')
        end.setAttribute('role', 'status')
        end.textContent = text
        el.appendChild(end)
      }
      if (shown.action) {
        const at = selected === shown.rows.length
        const button =
          shown.action === 'retry'
            ? actionOf('Try again', 'data-mention-retry', retry, at)
            : actionOf(
                shown.action === 'loading' ? 'Loading…' : 'Load more',
                'data-mention-more',
                more,
                at,
              )
        if (shown.action === 'loading') button.setAttribute('aria-disabled', 'true')
        el.appendChild(button)
      }
      const active = el.querySelector('.mentionpop-row.active')
      if (active) (active as HTMLElement).scrollIntoView({ block: 'nearest' })
    }

    return {
      onStart: (props) => {
        el = document.createElement('div')
        el.className = 'mentionpop'
        el.setAttribute('data-mention-popup', '')
        const dom = props.editor?.view.dom as HTMLElement | undefined
        org = dom?.getAttribute('data-qivo-org') || P.homeOrg
        task = dom?.getAttribute('data-qivo-task') || ''
        command = props.command
        reset()
        update(props.query)
        unmount = props.mount(el)
        // a picture that arrives while the popup is open shows without a
        // keystroke: each store change builds the rows again when one of
        // their pictures changed
        stopWatch?.()
        stopWatch = P.subscribe(() => {
          if (!el) return
          const now = current()
            .rows.map((u) => pictureOf(u.id) ?? '')
            .join('\n')
          if (now !== pictures) rebuild()
        })
      },
      onUpdate: (props: SuggestionProps<MentionChoice, MentionNodeAttrs>) => {
        command = props.command
        update(props.query)
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        // the plugin dismisses on Escape AFTER this callback and consumes
        // the event in ProseMirror, but PM only preventDefaults, it does
        // not stop propagation, and the editor's own Escape handler reverts
        // a dirty draft. Closing the picker must never cost the draft.
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.stopPropagation()
          return false // the plugin's native branch runs the exit
        }
        const shown = current()
        const count = itemCount(shown)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (count) {
            selected = (selected + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
            rebuild()
          }
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          // consumed even with no match: letting Tab move focus out would
          // orphan the popup (the suggestion match survives the blur)
          const onAction = !!shown.action && selected === shown.rows.length
          if (shown.stale) enterFor = typedKey
          else if (onAction && shown.action === 'retry') retry()
          else if (onAction) more()
          else {
            const u = shown.rows[selected]
            if (u) pick(u)
          }
          return true
        }
        return false
      },
      onExit: () => {
        reset()
        stopWatch?.()
        stopWatch = null
        unmount?.()
        unmount = null
        el = null
      },
    }
  },
}
