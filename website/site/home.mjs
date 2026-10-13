// Image links still open the full screenshot when JavaScript is unavailable.
const lightbox = document.querySelector('.lightbox')

if (lightbox && typeof lightbox.showModal === 'function') {
  let opener
  const image = lightbox.querySelector('img')

  document.querySelectorAll('[data-enlarge]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      opener = link
      image.src = link.href
      image.alt = link.dataset.alt
      lightbox.querySelector('[data-image-title]').textContent = link.dataset.title
      lightbox.showModal()
    })
  })

  lightbox.querySelector('[data-close]').addEventListener('click', () => lightbox.close())
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) {
      const bounds = lightbox.getBoundingClientRect()
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      ) {
        lightbox.close()
      }
    }
  })
  // Focus returns to the image link. The page may have scrolled behind the
  // dialog, and focus() alone does not scroll, because the dialog usually
  // refocuses the link first. scrollIntoView brings it back clear of the
  // sticky header and leaves a visible link where it is.
  lightbox.addEventListener('close', () => {
    opener?.focus({ preventScroll: true })
    opener?.scrollIntoView({ block: 'nearest' })
  })
}
