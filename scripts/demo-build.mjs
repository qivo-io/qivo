#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertDemoTarget } from './demo-deploy.mjs'
import { writeDeploymentReceipt } from './deployment-receipt.mjs'
import {
  deploymentName,
  ignoredTheTarget,
  isPreviewDeployKey,
  previewSiteUrl,
} from './vercel-build.mjs'

/** Files only the website build writes. It skips the demo, so finding one means the
    demo would publish the marketing site, pricing and docs on demo.qivo.io. */
export const WEBSITE_OUTPUT = ['index.html', 'docs', 'pricing', 'marketing', 'sitemap.xml']

export function finishDemoBuild(directory = 'dist') {
  for (const name of WEBSITE_OUTPUT)
    if (existsSync(join(directory, name)))
      throw new Error(`The demo build must not include the website, found ${name}.`)
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
  // vercel.json redirects demo.qivo.io's `/` to `/app` first. Demo branch previews use
  // other hosts, so this page sends them there too.
  writeFileSync(
    join(directory, 'index.html'),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the page's own script holds this template literal
    '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=/app"><script>location.replace(`/app${location.search}${location.hash}`)</script></head></html>\n',
  )
  visit(directory)
  // The demo hides the operator console.
  writeFileSync(join(directory, 'admin.html'), readFileSync(join(directory, 'app.html'), 'utf8'))
  writeFileSync(join(directory, 'robots.txt'), 'User-agent: *\nDisallow: /\n')
  const guidance =
    '# Qivo private demo\n\nThis host provides temporary, private browser workspaces. External agent connections, MCP, REST credentials and account registration are disabled. Each demo expires after 24 hours.\n\nCreate a regular workspace at https://qivo.io/app#signup. Full product guidance: https://qivo.io/llms.txt\n'
  for (const name of ['llms.txt', 'skill.md', 'auth.md'])
    writeFileSync(join(directory, name), guidance)
}

/* The build command. `run` is execFileSync, `finish` is finishDemoBuild and
 * `receipt` writes dist/version.json; the tests pass their own to see which
 * commands run. */
export function main(
  env,
  { run = execFileSync, finish = finishDemoBuild, receipt = writeDeploymentReceipt } = {},
) {
  assertDemoTarget(env)
  const preview = isPreviewDeployKey(env.CONVEX_DEPLOY_KEY)
  const name = deploymentName(env)
  if (!name || (!preview && name !== env.DEMO_CONVEX_DEPLOYMENT))
    throw new Error('The injected Convex URL does not match the dedicated demo deployment.')
  const command = (args) => {
    const out = run('npx', ['convex', 'env', ...args, ...(preview ? ['--deployment', name] : [])], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (ignoredTheTarget(out)) throw new Error('Convex ignored the requested demo target.')
    return out.trim()
  }
  if (preview) {
    // Same claim → origin setup → build → push ordering as normal previews.
    command(['set', 'SITE_URL', previewSiteUrl(env)])
    command(['set', 'APP_MODE', 'demo'])
    // before convex pushes the functions, so crons.ts registers no job
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
  run('npm', ['run', 'build'], { stdio: 'inherit' })
  finish()
  receipt(env)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.env)
