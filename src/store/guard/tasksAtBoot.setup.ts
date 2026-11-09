/* The node project's stores boot as the app does, without asking for every
   task (store/liveParts.ts TASKS.atBoot), so each suite reads a task from
   its window's answer or a view's. The store halves of the view parity
   suites and the Roadmap undo suite still ask for every task until the
   held arm goes. It runs before each test file, so a file that turned it
   on leaves the next one the default. */

import { TASKS } from '../liveParts'

TASKS.atBoot = false
