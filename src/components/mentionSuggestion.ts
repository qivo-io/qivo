/* @-mention suggestion for the description/comment editor. Typing "@" opens
   a member picker anchored under the caret (the suggestion plugin's managed
   mount handles positioning and outside-click dismissal; Escape is handled by
   the plugin itself — it exits the suggestion without bubbling to the modal).
   Selecting inserts a mention node {id, label}, which the dialect stores as
   @[Name](user:<uuid>) — the byte pattern the server's notify triggers parse.

   Plain DOM, no React: the popup is a transient list rebuilt on each update,
   which keeps this out of the editor's render cycle entirely. */
import type { MentionNodeAttrs } from '@tiptap/extension-mention'
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'
import { gravatarUrl } from '../lib/gravatar'
import { matchesAllWords } from '../lib/search'
import { P } from '../store/planner'

type Member = {
  id: string
  name: string
  initials: string
  color: string
  email: string | null
  avatarPath: string | null
  avatarUrl: string | null
}

/** Avatar size in this popup, in CSS px — matches `.mentionpop-av` in
    tokens.css, and is what the Gravatar request is sized against. */
const AV_PX = 28

const MAX_ITEMS = 8

function memberMatches(u: Member, q: string): boolean {
  return matchesAllWords(`${u.name}\n${u.initials}\n${u.email || ''}`, q)
}

export const mentionSuggestion: Omit<SuggestionOptions<Member, MentionNodeAttrs>, 'editor'> = {
  char: '@',
  allowSpaces: true,
  // scoped to the editor's organization (0081): `P.users` is blended across
  // every org I hold a seat in, and only someone inside THIS task's org can
  // receive the mention — offering anyone else would render a mention that
  // notifies nobody, the exact parity trap 0075 closed on the server side
  items: ({ query, editor }) => {
    const dom = editor && (editor.view.dom as HTMLElement)
    const org = dom?.getAttribute('data-qivo-org') || P.homeOrg
    return (P.usersIn(org) as Member[]).filter((u) => memberMatches(u, query)).slice(0, MAX_ITEMS)
  },

  render: () => {
    let el: HTMLDivElement | null = null
    let unmount: (() => void) | null = null
    let items: Member[] = []
    let selected = 0
    let command: (attrs: MentionNodeAttrs) => void = () => {}

    const rebuild = () => {
      if (!el) return
      el.innerHTML = ''
      if (!items.length) {
        const empty = document.createElement('div')
        empty.className = 'mentionpop-empty'
        empty.textContent = 'No matching members'
        el.appendChild(empty)
        return
      }
      items.forEach((u, i) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = `mentionpop-row${i === selected ? ' active' : ''}`
        row.setAttribute('data-mention-option', u.name)
        // this popup builds its own avatar in plain DOM, so it inherits
        // nothing from <Avatar> — the same three layers are assembled by hand:
        // initials text, with an uploaded or Gravatar picture painted over it
        const av = document.createElement('span')
        av.className = 'mentionpop-av'
        av.style.background = u.color
        av.textContent = u.initials
        const src = u.avatarPath
          ? u.avatarUrl
          : P.org.gravatarAvatars
            ? gravatarUrl(u.email, AV_PX)
            : null
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
        const addr = document.createElement('span')
        addr.className = 'mentionpop-email'
        addr.textContent = u.email || ''
        const identity = document.createElement('span')
        identity.className = 'flex min-w-0 flex-1 flex-col text-left'
        identity.append(name, addr)
        row.append(av, identity)
        // mousedown, not click: the editor must keep focus and selection
        row.addEventListener('mousedown', (e) => {
          e.preventDefault()
          command({ id: u.id, label: u.name })
        })
        // guard: rebuild() replaces the row under a stationary cursor, and
        // the fresh node re-fires mouseenter — unguarded, that loops forever
        row.addEventListener('mouseenter', () => {
          if (selected !== i) {
            selected = i
            rebuild()
          }
        })
        el!.appendChild(row)
      })
      const active = el.querySelector('.mentionpop-row.active')
      if (active) (active as HTMLElement).scrollIntoView({ block: 'nearest' })
    }

    const apply = (props: SuggestionProps<Member, MentionNodeAttrs>) => {
      items = props.items
      command = props.command
      if (selected >= items.length) selected = Math.max(0, items.length - 1)
      rebuild()
    }

    return {
      onStart: (props) => {
        el = document.createElement('div')
        el.className = 'mentionpop'
        el.setAttribute('data-mention-popup', '')
        selected = 0
        apply(props)
        unmount = props.mount(el)
      },
      onUpdate: (props) => {
        apply(props)
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        // the plugin dismisses on Escape AFTER this callback and consumes
        // the event in ProseMirror — but PM only preventDefaults, it does
        // not stop propagation, and the editor's own Escape handler reverts
        // a dirty draft. Closing the picker must never cost the draft.
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.stopPropagation()
          return false // the plugin's native branch runs the exit
        }
        if (event.key === 'ArrowDown') {
          if (items.length) {
            selected = (selected + 1) % items.length
            rebuild()
          }
          return true
        }
        if (event.key === 'ArrowUp') {
          if (items.length) {
            selected = (selected + items.length - 1) % items.length
            rebuild()
          }
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const u = items[selected]
          if (u) command({ id: u.id, label: u.name })
          // consumed even with no match: letting Tab move focus out would
          // orphan the popup (the suggestion match survives the blur)
          return true
        }
        return false
      },
      onExit: () => {
        unmount?.()
        unmount = null
        el = null
      },
    }
  },
}
