// The busy phase's spinning processes (scripts/benchmark-load.mjs replay),
// kept here so a test can start them and check that a loop that cannot
// start, stops early or outlives its coordinator is caught.
import { spawn } from 'node:child_process'

/** A loop's program: it spins, and every few million turns checks that
    its parent is still `parent`, the process that started it, so a
    coordinator killed by a signal, whose 'exit' handlers never run, leaves
    no loop spinning. The pid is given rather than read at the loop's start,
    which a coordinator that died first would already have changed. */
const loopOf = (parent) => `for(let i=1;;i++)if(i%5e6===0&&process.ppid!==${parent})process.exit()`

/**
 * Starts `count` processes that spin, each pinned to `cpus` (taskset) when
 * given. `check()` throws once a loop could not start or stopped before
 * `stop()`, as every loop does where taskset refuses CPUs the machine does
 * not have, so the busy phase fails rather than being measured without its
 * load. `stop()` kills them all, as does the coordinator's own exit.
 */
export function busyLoops(count, cpus) {
  let failure = null
  let stopping = false
  // taskset execs the loop, so its parent is this process either way
  const code = loopOf(process.pid)
  const loops = Array.from({ length: count }, () => {
    const loop = cpus
      ? spawn('taskset', ['-c', cpus, process.execPath, '-e', code], {
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      : spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] })
    let said = ''
    loop.stderr.on('data', (chunk) => {
      said += chunk
    })
    loop.on('error', (error) => {
      failure ??= `a busy loop could not start: ${error.message}`
    })
    loop.on('close', (code, signal) => {
      if (!stopping)
        failure ??= `a busy loop stopped (${signal ?? code})${said ? `: ${said.trim().slice(0, 200)}` : ''}`
    })
    return loop
  })
  const stop = () => {
    stopping = true
    for (const loop of loops) loop.kill('SIGKILL')
    process.off('exit', stop)
  }
  // a run that ends early takes its loops with it
  process.once('exit', stop)
  return {
    pids: loops.map((loop) => loop.pid ?? null),
    check() {
      if (failure) throw new Error(failure)
    },
    stop,
  }
}
