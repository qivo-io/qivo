/* Fails when a TypeScript file in the repository is in no typecheck that
 * `npm run verify:local` runs, or when CI's workflow skips one of those
 * typechecks. The typechecks are the tsc runs of verify:local's scripts,
 * followed through `npm run`, and a file counts when it is in the program of
 * one, by include or by import. Every config sets skipLibCheck, which skips
 * the errors inside declaration files, so this also typechecks each
 * hand-written declaration file on its own, with the options of the first
 * config whose program holds it. */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const tsc = path.join(
  path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
)
const typescriptFile = /\.[cm]?tsx?$/
const declarationFile = /\.d\.[cm]?ts$/
// Convex writes these, and they import types that fail without skipLibCheck.
const generatedDeclarations = 'convex/_generated/'

/**
 * Returns the tsc projects a script's command runs, as config paths, and the
 * names of the scripts that run tsc themselves, following `npm run`.
 */
function typecheckRuns(scripts, name, seen = new Set()) {
  const projects = new Set()
  const names = new Set()
  if (seen.has(name)) return { projects, names }
  seen.add(name)
  for (const command of (scripts[name] ?? '').split('&&').map((part) => part.trim())) {
    const script = command.match(/^npm run (\S+)/)?.[1]
    if (script) {
      const inner = typecheckRuns(scripts, script, seen)
      for (const project of inner.projects) projects.add(project)
      for (const inside of inner.names) names.add(inside)
    } else if (/^(npx )?tsc(\s|$)/.test(command)) {
      const project = command.match(/(?:^|\s)(?:-p|--project)\s+(\S+)/)?.[1] ?? '.'
      projects.add(project.endsWith('.json') ? project : path.join(project, 'tsconfig.json'))
      names.add(name)
    }
  }
  return { projects, names }
}

/** Lists the repository's TypeScript files, tracked or new, that Git does not ignore. */
function repositoryFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => typescriptFile.test(file) && fs.existsSync(file))
}

/** Returns the files in a project's program, as absolute paths. */
async function programFiles(project) {
  const { stdout } = await run(process.execPath, [tsc, '-p', project, '--listFilesOnly'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return new Set(
    stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => path.resolve(file)),
  )
}

/** Typechecks one declaration file with a project's options and returns the errors in repository files. */
async function declarationErrors(file, project, config) {
  fs.writeFileSync(
    config,
    JSON.stringify({
      extends: path.resolve(project),
      compilerOptions: { noEmit: true, skipLibCheck: false },
      include: [],
      files: [path.resolve(file)],
    }),
  )
  const output = await run(process.execPath, [tsc, '-p', config, '--pretty', 'false']).catch(
    (failure) => failure,
  )
  return output.stdout
    .split(/\r?\n/)
    .filter((line) => / error TS\d+:/.test(line) && !line.includes('node_modules'))
}

const failures = []
const { scripts } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const { projects, names } = typecheckRuns(scripts, 'verify:local')
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

const programs = await Promise.all(
  [...projects].map(async (project) => ({ project, files: await programFiles(project) })),
)
const files = repositoryFiles()
for (const file of files)
  if (!programs.some(({ files }) => files.has(path.resolve(file))))
    failures.push(`${file} is in no typecheck that verify:local runs.`)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-typecheck-coverage-'))
try {
  const declarations = files.filter(
    (file) => declarationFile.test(file) && !file.startsWith(generatedDeclarations),
  )
  const errors = await Promise.all(
    declarations.map((file, index) => {
      const program = programs.find(({ files }) => files.has(path.resolve(file)))
      const config = path.join(temporary, `${index}.json`)
      return program ? declarationErrors(file, program.project, config) : []
    }),
  )
  failures.push(...errors.flat())
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}

if (failures.length) {
  console.error(failures.join('\n'))
  console.error(
    '\nAdd each TypeScript file to a tsconfig that a typecheck script in verify:local runs, run that script in CI, and fix the errors.',
  )
  process.exit(1)
}
console.log(`${files.length} TypeScript files are in the typechecks of ${projects.size} configs.`)
