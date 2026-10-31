/* Lets a component test file close only after the editors it unmounted are
 * gone. Wired from vitest.config.mts for every suite, it acts only where
 * jsdom provides a document.
 *
 * Tiptap's useEditor (@tiptap/react, EditorInstanceManager.scheduleDestroy)
 * destroys an unmounted editor on a 1 ms timer, and the destroy reads
 * `window`. When a file's last test unmounts an editor and a busy worker
 * closes jsdom before that timer runs, the destroy throws "window is not
 * defined" outside any test, and Vitest fails the run although every test
 * passed. Timers of the same delay run in the order they were set, so a
 * 1 ms timer set after the last unmount runs after every destroy queued
 * before it. */
import { afterAll, vi } from 'vitest'

if (typeof document !== 'undefined') {
  afterAll(async () => {
    // a test that left fake timers on would hold this wait until the hook
    // timed out; their pending destroys go with them and never run
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 1))
  })
}
