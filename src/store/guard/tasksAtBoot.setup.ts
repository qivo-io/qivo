/* The node project's stores boot with every task in tests (store/liveParts.ts
   TASKS.atBoot), so the suites that test the store with every task held,
   among them Search (panels/Palette.test.tsx), the Inbox
   (panels/inboxLoading.test.tsx) and the task window (TaskDetail, TaskGone,
   TaskSections), keep doing so. The app boots without, so the Board suites
   (views/boardFixture.setup.tsx), the not-asked suites and the not-asked
   cases of the direct links suites set it off themselves, before their
   store loads. It runs before each test file, so a file that turned it off
   leaves the next one the default. */

import { TASKS } from '../liveParts'

TASKS.atBoot = true
