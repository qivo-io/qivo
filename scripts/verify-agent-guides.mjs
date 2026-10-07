#!/usr/bin/env node
// Vite copies public/; verify the exact directory Vercel will publish before
// allowing the shared production/preview/CI build to succeed.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const guides = ['llms.txt', 'skill.md', 'auth.md']

export function verifyAgentGuides(root = projectRoot) {
  const { outputDirectory } = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) {
    throw new Error('vercel.json must name the outputDirectory to check before deployment')
  }

  for (const guide of guides) {
    const source = readFileSync(join(root, 'public', guide))
    if (!source.toString('utf8').trim()) {
      throw new Error(`public/${guide} is empty`)
    }
    const destination = join(outputDirectory, guide)
    let built
    try {
      built = readFileSync(resolve(root, destination))
    } catch (cause) {
      throw new Error(`Cannot read ${destination}; /${guide} must exist at the deployment root`, {
        cause,
      })
    }
    if (!source.equals(built)) {
      throw new Error(`${destination} differs from public/${guide}; rebuild before deployment`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyAgentGuides()
    console.log(
      `[agent-guides] Verified deployment root files: ${guides.map((f) => `/${f}`).join(', ')}`,
    )
  } catch (error) {
    console.error(`[agent-guides] ${error.message}`)
    process.exitCode = 1
  }
}
