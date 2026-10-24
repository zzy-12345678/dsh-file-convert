// tsc does not copy non-TS assets; the UI server loads index.html from the
// assets/ folder next to its compiled location, so sync it into lib/. The
// client bundle is additionally exposed at lib/ui/client.js for the package
// exports map (the DSH host resolves it via the "./client" export).
import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const libUi = path.join(root, '..', 'lib', 'ui')
mkdirSync(libUi, { recursive: true })
cpSync(path.join(root, '..', 'src', 'ui', 'assets'), path.join(libUi, 'assets'), { recursive: true })
copyFileSync(path.join(libUi, 'assets', 'client.js'), path.join(libUi, 'client.js'))
