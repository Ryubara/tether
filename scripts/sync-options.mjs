// Keeps `userConfig` in .claude-plugin/plugin.json equal to the options table in src/options/options.ts.
// The README's options table (between its options:begin and options:end lines) is generated from the same table.
// `node scripts/sync-options.mjs` rewrites both; `--check` only compares (CI runs it) and exits 1 on drift.
// Node 22.6+ needs --experimental-strip-types to import the .ts table; 23.6+ does it by itself.
import { readFileSync, writeFileSync } from 'node:fs'
import { CONFIG_PATH, OPTIONS, PANES } from '../src/options/options.ts'

const path = new URL('../.claude-plugin/plugin.json', import.meta.url)
const readmePath = new URL('../README.md', import.meta.url)
const manifest = JSON.parse(readFileSync(path, 'utf8'))

const form = (e, type) => ({ type, title: e.title, description: e.description, default: e.default })
const userConfig = { [CONFIG_PATH.option]: form(CONFIG_PATH, 'string') }
for (const [i, e] of OPTIONS.entries()) {
  userConfig[e.option] = form(e, e.kind)
  // A section's pane options follow its last option
  if (OPTIONS[i + 1]?.section !== e.section) for (const p of PANES.filter(p => p.section === e.section)) userConfig[p.option] = form(p, 'number')
}

// The README table: one row per option, in the form's order
const cell = v => (v === '' ? '(empty)' : '`' + String(v) + '`')
const rows = Object.entries(userConfig).map(([name, o]) => `| \`${name}\` | ${cell(o.default)} | ${o.description.replace(/\|/g, '\\|')} |`)
const table = ['| Option | Default | What it does |', '| --- | --- | --- |', ...rows].join('\n')
const readme = readFileSync(readmePath, 'utf8')
const begin = readme.indexOf('<!-- options:begin')
const end = readme.indexOf('<!-- options:end -->')
if (begin < 0 || end < begin) throw new Error('README.md lacks its options:begin / options:end lines')
const beginEnd = readme.indexOf('\n', begin) + 1
const newReadme = readme.slice(0, beginEnd) + '\n' + table + '\n\n' + readme.slice(end)

const same = JSON.stringify(manifest.userConfig) === JSON.stringify(userConfig) && newReadme === readme
if (same) {
  console.log('options: plugin.json and README.md match src/options/options.ts')
} else if (process.argv.includes('--check')) {
  console.error('options: plugin.json or README.md differs from src/options/options.ts; run `node scripts/sync-options.mjs`')
  process.exit(1)
} else {
  manifest.userConfig = userConfig
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(readmePath, newReadme)
  console.log(`options: wrote ${Object.keys(userConfig).length} options to plugin.json and README.md`)
}
