/* Fails when a TypeScript file in the repository is in no typecheck that
 * `npm run verify:local` runs, or when CI's workflow skips one of those
 * typechecks. The typechecks are the tsc runs of verify:local's scripts,
 * followed through `npm run`, and a file counts when it is in the program of
 * one, by include or by import. A repository with convex/ must also run
 * scripts/check-convex-runtime.mjs that way, which checks the globals of the
 * code that runs in Convex's default runtime. Every config sets skipLibCheck,
 * which skips the errors inside declaration files, so this also typechecks
 * each program that holds a hand-written declaration file with skipLibCheck
 * off, and fails on the errors located in those files or in a library
 * declaration they conflict with. */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'

const run = promisify(execFile)
// The TypeScript of the repository being checked.
const tsc = path.join(
  path.dirname(createRequire(path.resolve('package.json')).resolve('typescript/package.json')),
  'bin',
  'tsc',
)
// tsc resolves its working directory from PWD, which names a symlinked path
// when the shell came through one, so it gets the real path that Node uses.
const tscOptions = { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PWD: process.cwd() } }
const typescriptFile = /\.[cm]?tsx?$/
// TypeScript treats `name.d.<extension>.ts` as a declaration file too.
const declarationFile = /\.d\.(?:[cm]ts|(?:[^/\\]+\.)?ts)$/
// Convex writes these, and they import types that fail without skipLibCheck.
const generatedDeclarations = 'convex/_generated/'

// Checks the globals of convex/'s default-runtime code, which tsc checks with Node's.
const convexRuntimeCheck = 'node scripts/check-convex-runtime.mjs'

/**
 * Returns the tsc projects a script's command runs, as config paths, the
 * names of the scripts that run tsc or the convex runtime check themselves,
 * following `npm run`, and whether the convex runtime check runs.
 */
function typecheckRuns(scripts, name, seen = new Set()) {
  const projects = new Set()
  const names = new Set()
  let convexRuntime = false
  if (seen.has(name)) return { projects, names, convexRuntime }
  seen.add(name)
  for (const command of (scripts[name] ?? '').split('&&').map((part) => part.trim())) {
    const script = command.match(/^npm run (\S+)/)?.[1]
    if (script) {
      const inner = typecheckRuns(scripts, script, seen)
      for (const project of inner.projects) projects.add(project)
      for (const inside of inner.names) names.add(inside)
      convexRuntime ||= inner.convexRuntime
    } else if (/^(npx )?tsc(\s|$)/.test(command)) {
      const project = command.match(/(?:^|\s)(?:-p|--project)\s+(\S+)/)?.[1] ?? '.'
      projects.add(project.endsWith('.json') ? project : path.join(project, 'tsconfig.json'))
      names.add(name)
    } else if (command === convexRuntimeCheck) {
      convexRuntime = true
      names.add(name)
    }
  }
  return { projects, names, convexRuntime }
}

/** Lists the repository's TypeScript files, tracked or new, that Git does not ignore. */
function repositoryFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => typescriptFile.test(file) && fs.existsSync(file))
}

/**
 * Runs tsc and returns its output, exit code and signal, whether it
 * succeeded or not.
 */
function tscRun(args) {
  return run(process.execPath, [tsc, ...args], tscOptions).then(
    (output) => ({ ...output, code: 0, signal: null }),
    (failure) => failure,
  )
}

/**
 * Returns the files in a project's program, as absolute paths, and a failure
 * when tsc could not list them, such as for a missing `@types` package.
 */
async function programFiles(project) {
  const { stdout, code, signal } = await tscRun(['-p', project, '--listFilesOnly'])
  const lines = (stdout ?? '').split(/\r?\n/)
  const errors = lines.filter((line) => /error TS\d+:/.test(line)).join('\n')
  return {
    project,
    files: new Set(lines.filter((line) => path.isAbsolute(line)).map((file) => path.resolve(file))),
    failure:
      code === 0
        ? undefined
        : `tsc could not list the files of ${project} (${signal ?? code}). ${errors}`.trim(),
  }
}

/**
 * Typechecks a project with skipLibCheck off and returns the errors that
 * concern the given declaration files, the ones without a file, or a failure
 * when tsc did not finish. An error counts when it is located in one of the
 * files or names one as a related location, as tsc does when a declaration
 * conflicts with one that comes earlier in the program.
 */
async function declarationErrors(project, declarations) {
  const { stdout, stderr, code, signal } = await tscRun([
    '-p',
    project,
    '--noEmit',
    '--skipLibCheck',
    'false',
    '--pretty',
    'true',
  ])
  // The pretty output is the only one with related locations. It starts each
  // error at the line's start, indents its related locations and ends with
  // a count of the errors.
  const lines = stripVTControlCharacters(stdout ?? '').split(/\r?\n/)
  const reported = []
  for (const line of lines) {
    const header = line.match(/^(?:(.+):\d+:\d+ - )?error TS\d+: /)
    if (header)
      reported.push({ text: line, files: header[1] ? [header[1]] : [], global: !header[1] })
    const related = line.match(/^\s+(.+):\d+:\d+ - /)
    if (related && reported.length) {
      reported.at(-1).files.push(related[1])
      reported.at(-1).text += `\n  ${line.trim()}`
    }
  }
  // tsc exits 1 or 2 after it reports errors, and anything else means it stopped.
  const counted = lines.some((line) => /^Found \d+ errors?\b/.test(line))
  const finished =
    !signal && ((code === 0 && !reported.length) || ((code === 1 || code === 2) && counted))
  if (!finished)
    return [`tsc did not finish checking ${project} (${signal ?? code}). ${stderr ?? ''}`.trim()]
  return reported
    .filter(
      ({ files, global }) => global || files.some((file) => declarations.has(path.resolve(file))),
    )
    .map(({ text }) => `${project}: ${text}`)
}

const failures = []
const { scripts } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const { projects, names, convexRuntime } = typecheckRuns(scripts, 'verify:local')
if (fs.existsSync('convex/tsconfig.json') && !convexRuntime)
  failures.push(
    `verify:local does not run \`${convexRuntimeCheck}\`, which checks that convex/'s default-runtime code uses no Node global.`,
  )
// A step that is present but skipped or allowed to fail still counts here.
const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8')
for (const name of names)
  if (
    !workflow
      .split(/\r?\n/)
      .some((line) => line.trim().replace(/^- /, '') === `run: npm run ${name}`)
  )
    failures.push(
      `.github/workflows/ci.yml does not run \`npm run ${name}\`, which verify:local runs.`,
    )

const programs = await Promise.all([...projects].map(programFiles))
for (const { failure } of programs) if (failure) failures.push(failure)
const files = repositoryFiles()
for (const file of files)
  if (!programs.some(({ files }) => files.has(path.resolve(file))))
    failures.push(`${file} is in no typecheck that verify:local runs.`)

const declarations = files
  .filter((file) => declarationFile.test(file) && !file.startsWith(generatedDeclarations))
  .map((file) => path.resolve(file))
// One project after another, since each is a full typecheck.
for (const program of programs) {
  const held = new Set(declarations.filter((file) => program.files.has(file)))
  if (held.size) failures.push(...(await declarationErrors(program.project, held)))
}

if (failures.length) {
  console.error(failures.join('\n'))
  console.error(
    '\nAdd each TypeScript file to a tsconfig that a typecheck script in verify:local runs, run that script in CI, and fix the errors.',
  )
  process.exit(1)
}
console.log(`${files.length} TypeScript files are in the typechecks of ${projects.size} configs.`)
