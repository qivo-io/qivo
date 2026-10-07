import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'

const root = path.resolve('src')
const allowlist = JSON.parse(fs.readFileSync('scripts/ui-runtime-style-allowlist.json', 'utf8'))
const files = []
// The mention picker is the one imperative feature renderer. Keep its tooltip
// check explicit instead of treating every data/model .ts file as UI markup.
const imperativeTooltipFiles = [path.join(root, 'components', 'mentionSuggestion.ts')].filter(
  (file) => fs.existsSync(file),
)
const errors = []
const nativeControls = new Set(['button', 'input', 'select', 'textarea'])
const legacyClasses = new Set(['tbtn', 'iconbtn', 'mdbtn', 'provider-btn', 'scalein', 'palettein'])

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

function literalText(node) {
  if (!node) return undefined
  if (ts.isJsxExpression(node)) return literalText(node.expression)
  return isStringLiteralLike(node) ? node.text : undefined
}

function isDomFactory(node) {
  return (
    node &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'document' &&
    ['createElement', 'createElementNS'].includes(node.expression.name.text)
  )
}

function isInsideSvg(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isJsxElement(parent) &&
      ts.isIdentifier(parent.openingElement.tagName) &&
      parent.openingElement.tagName.text === 'svg'
    )
      return true
  }
  return false
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (file === path.join(root, 'components', 'ui')) continue
      walk(file)
    } else if (entry.name.endsWith('.tsx')) files.push(file)
  }
}
walk(root)

const styleCounts = new Map()
// TypeScript 7 parses through its native API. Open every walked file explicitly
// so a future tsconfig exclusion cannot silently exempt feature code.
const api = new API()
try {
  const inspectedFiles = [...files, ...imperativeTooltipFiles]
  const snapshot = api.updateSnapshot({ openFiles: inspectedFiles })
  for (const file of inspectedFiles) {
    const project = snapshot.getDefaultProjectForFile(file)
    const program = project?.program
    const sf = program?.getSourceFile(file)
    if (!sf) throw new Error(`UI migration guard could not parse ${file}`)
    const relative = path.relative(process.cwd(), file)
    if (program.getSyntacticDiagnostics(file).length) {
      errors.push(`${relative} has syntax errors; UI migration guard requires valid source`)
    }

    function line(node) {
      return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    }
    function checkClassExpression(node) {
      if (isStringLiteralLike(node)) {
        for (const token of node.text.split(/\s+/)) {
          if (legacyClasses.has(token))
            errors.push(`${relative}:${line(node)} uses legacy .${token}`)
        }
      }
      node.forEachChild(checkClassExpression)
    }
    function checkStaticStyle(node) {
      if (
        ts.isPropertyAssignment(node) &&
        (isStringLiteralLike(node.initializer) || ts.isNumericLiteral(node.initializer))
      ) {
        errors.push(`${relative}:${line(node)} keeps static presentation in style`)
      }
      node.forEachChild(checkStaticStyle)
    }
    const domSymbols = new Set()
    if (imperativeTooltipFiles.includes(file)) {
      // Symbols distinguish an element named `row` from an unrelated data row
      // in another scope. Collect creations before inspecting property writes.
      function collectDomElements(node) {
        const target =
          ts.isVariableDeclaration(node) && isDomFactory(node.initializer)
            ? node.name
            : ts.isBinaryExpression(node) &&
                ts.isEqualsToken(node.operatorToken) &&
                isDomFactory(node.right)
              ? node.left
              : undefined
        if (target && ts.isIdentifier(target)) {
          const symbol = project.checker.getSymbolAtLocation(target)
          if (symbol) domSymbols.add(symbol.id)
        }
        node.forEachChild(collectDomElements)
      }
      collectDomElements(sf)
    }
    function isTrackedDomElement(node) {
      return (
        domSymbols.size > 0 &&
        ts.isIdentifier(node) &&
        domSymbols.has(project.checker.getSymbolAtLocation(node)?.id)
      )
    }
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const nativeTag = ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text)
        if (ts.isIdentifier(node.tagName) && nativeControls.has(node.tagName.text)) {
          errors.push(`${relative}:${line(node)} uses raw <${node.tagName.text}>`)
        }
        if (nativeTag && node.tagName.text === 'title' && isInsideSvg(node)) {
          errors.push(
            `${relative}:${line(node)} uses an SVG <title> tooltip; use shared HoverTooltip and an accessible label`,
          )
        }
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue
          if (nativeTag && attr.name.text === 'title') {
            errors.push(
              `${relative}:${line(attr)} uses a native title tooltip; use shared HoverTooltip`,
            )
          }
          if (attr.name.text === 'role' && literalText(attr.initializer) === 'tooltip') {
            errors.push(
              `${relative}:${line(attr)} defines a custom tooltip; use the shared tooltip primitives`,
            )
          }
          if (attr.name.text === 'className' && attr.initializer)
            checkClassExpression(attr.initializer)
          if (attr.name.text === 'style') {
            styleCounts.set(relative, (styleCounts.get(relative) ?? 0) + 1)
            if (
              attr.initializer &&
              ts.isJsxExpression(attr.initializer) &&
              attr.initializer.expression
            ) {
              checkStaticStyle(attr.initializer.expression)
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        ts.isEqualsToken(node.operatorToken) &&
        ts.isPropertyAccessExpression(node.left) &&
        isTrackedDomElement(node.left.expression) &&
        (node.left.name.text === 'title' ||
          (node.left.name.text === 'role' && literalText(node.right) === 'tooltip'))
      ) {
        errors.push(
          `${relative}:${line(node)} writes native/custom tooltip markup; use the shared tooltip primitives`,
        )
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'setAttribute' &&
        isTrackedDomElement(node.expression.expression) &&
        (literalText(node.arguments[0]) === 'title' ||
          (literalText(node.arguments[0]) === 'role' &&
            literalText(node.arguments[1]) === 'tooltip'))
      ) {
        errors.push(
          `${relative}:${line(node)} writes native/custom tooltip markup; use the shared tooltip primitives`,
        )
      }
      node.forEachChild(visit)
    }
    visit(sf)
  }
} finally {
  api.close()
}

for (const [file, count] of styleCounts) {
  const allowed = allowlist[file]
  if (!allowed) errors.push(`${file} has ${count} runtime style site(s) but is not allowlisted`)
  else if (allowed.count !== count) {
    errors.push(
      `${file} has ${count} runtime style site(s); reviewed allowlist says ${allowed.count}`,
    )
  }
}
for (const [file, allowed] of Object.entries(allowlist)) {
  const count = styleCounts.get(file) ?? 0
  if (count !== allowed.count)
    errors.push(`${file} allowlist is stale (${allowed.count} reviewed, ${count} found)`)
  if (!allowed.reason?.trim()) errors.push(`${file} has no runtime-style reason`)
}

const css = fs.readFileSync('src/styles/tokens.css', 'utf8')
for (const token of legacyClasses) {
  if (new RegExp(`\\.${token}(?:[^a-zA-Z0-9_-]|$)`).test(css)) {
    errors.push(`src/styles/tokens.css still defines or references .${token}`)
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(
  `UI migration guard passed (${files.length} feature files, ${[...styleCounts.values()].reduce((a, b) => a + b, 0)} reviewed runtime style sites; shared tooltips enforced, ${imperativeTooltipFiles.length} imperative renderer checked).`,
)
