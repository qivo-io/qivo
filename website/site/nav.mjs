// Keeps the website's navigation readable while a page scrolls. Every website
// page loads this. Without JavaScript the header still sticks and the docs
// sidebar still scrolls, only without these touches.

// Marks the sticky header once the page has scrolled, so the stylesheet draws
// the line under it.
const header = document.querySelector('header.top')

if (header) {
  const update = () => header.toggleAttribute('data-scrolled', window.scrollY > 0)
  window.addEventListener('scroll', update, { passive: true })
  // A reload or an anchor link can open the page already scrolled.
  update()
}

// A docs sidebar taller than the window scrolls on its own and opens at its
// top. When that hides the current page's entry, centre the entry instead.
// offsetTop counts from the sidebar only while the sidebar is sticky.
const sidebar = document.querySelector('.docnav')
const current = sidebar?.querySelector('[aria-current]')

if (
  current?.offsetParent === sidebar &&
  sidebar.scrollHeight > sidebar.clientHeight &&
  current.offsetTop + current.offsetHeight > sidebar.clientHeight
) {
  sidebar.scrollTop = current.offsetTop - (sidebar.clientHeight - current.offsetHeight) / 2
}

// Firefox leaves a link that is already partly in view half hidden when Tab
// moves focus to it inside the scrolling sidebar.
sidebar?.addEventListener('focusin', (event) => event.target.scrollIntoView({ block: 'nearest' }))
