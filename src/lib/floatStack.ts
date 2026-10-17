/* The fixed column that holds the floating notices and the toasts.

   Each layer portals into its own slot of one column, so they stack instead
   of covering each other. On a desktop the column sits at the bottom with the
   toasts on top, then the app update notice, then the snapshot notice. On a
   phone the notices sit at the top and the toasts above the tab bar. The
   column centers on the workspace content column, the axis of the page
   header (styles/float-stack.css).

   The column is a [data-top-layer] child of <body>, so modal layers leave it
   exposed and usable (lib/useHideOthers, the task window's inert siblings). */

const SLOTS = ['toasts', 'update', 'snapshot'] as const
export type FloatSlot = (typeof SLOTS)[number]

/** The element a floating layer portals into. Creates the column on first use. */
export function floatSlot(slot: FloatSlot): HTMLElement {
  let stack = document.querySelector<HTMLElement>('body > [data-float-stack]')
  if (!stack) {
    stack = document.createElement('div')
    stack.className = 'float-stack'
    stack.setAttribute('data-float-stack', '')
    stack.setAttribute('data-top-layer', '')
    for (const name of SLOTS) {
      const element = document.createElement('div')
      element.setAttribute('data-float-slot', name)
      stack.append(element)
    }
    document.body.append(stack)
  }
  const element = stack.querySelector<HTMLElement>(`[data-float-slot="${slot}"]`)
  if (!element) throw new Error(`The floating column has no ${slot} slot`)
  return element
}
