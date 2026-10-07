#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertDemoTarget } from './demo-deploy.mjs'
import { writeDeploymentReceipt } from './deployment-receipt.mjs'
import {
  deploymentName,
  ignoredTheTarget,
  isPreviewDeployKey,
  previewSiteUrl,
} from './vercel-build.mjs'

export function finishDemoBuild(directory = 'dist') {
  const visit = (path) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, item.name)
      if (item.isDirectory()) visit(file)
      else if (item.name.endsWith('.html')) {
        const html = readFileSync(file, 'utf8')
        writeFileSync(
          file,
          html.replace(/<head>/i, '<head><meta name="robots" content="noindex,nofollow">'),
        )
      }
    }
  }
  visit(directory)
  // vercel.json redirects `/` to `/app`; the demo hides the operator console.
  writeFileSync(join(directory, 'admin.html'), readFileSync(join(directory, 'app.html'), 'utf8'))
  writeFileSync(join(directory, 'robots.txt'), 'User-agent: *\nDisallow: /\n')
  const guidance =
    '# Qivo private demo\n\nThis host provides temporary, private browser workspaces. External agent connections, MCP, REST credentials and account registration are disabled. Each demo expires after 24 hours.\n\nCreate a regular workspace at https://qivo.io/app#signup. Full product guidance: https://qivo.io/llms.txt\n'
  for (const name of ['llms.txt', 'skill.md', 'auth.md'])
    writeFileSync(join(directory, name), guidance)
}

function main(env) {
  assertDemoTarget(env)
  const preview = isPreviewDeployKey(env.CONVEX_DEPLOY_KEY)
  const name = deploymentName(env)
  if (!name || (!preview && name !== env.DEMO_CONVEX_DEPLOYMENT))
    throw new Error('The injected Convex URL does not match the dedicated demo deployment.')
  const command = (args) => {
    const out = execFileSync(
      'npx',
      ['convex', 'env', ...args, ...(preview ? ['--deployment', name] : [])],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (ignoredTheTarget(out)) throw new Error('Convex ignored the requested demo target.')
    return out.trim()
  }
  if (preview) {
    // Same claim → origin setup → build → push ordering as normal previews.
    command(['set', 'SITE_URL', previewSiteUrl(env)])
    command(['set', 'APP_MODE', 'demo'])
    command(['set', 'QIVO_ENVIRONMENT', 'preview'])
    // Admission is enabled explicitly after verification, including previews.
  } else if (
    command(['get', 'QIVO_ENVIRONMENT']) !== 'demo' ||
    command(['get', 'APP_MODE']) !== 'demo' ||
    command(['get', 'SITE_URL']) !== 'https://demo.qivo.io'
  ) {
    throw new Error(
      'Configure APP_MODE=demo and SITE_URL=https://demo.qivo.io on the dedicated backend first.',
    )
  }
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
  finishDemoBuild()
  writeDeploymentReceipt(env)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.env)
