// Bundle the vendored Cursor++ server + our entry into dist/server.cjs.
import esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const VENDOR = path.join(import.meta.dirname, '..', 'vendor', 'CCursor', 'Cursor++')
const vendorModules = path.join(VENDOR, 'node_modules')

// build needs the vendored package's deps just to resolve imports (build-time only)
if (!fs.existsSync(vendorModules)) {
  console.error('[build] vendor deps are missing.')
  console.error('[build] run `npm run bootstrap` first, then build/publish again.')
  process.exit(1)
}

// version stamp baked into the bundle (shown in the startup log and on /health):
// BYOK_VERSION env (Docker build-arg / CI) > git short sha > package.json fallback
// (.git is stripped from the Docker build context, so git is best-effort)
function resolveVersion() {
  if (process.env.BYOK_VERSION) return process.env.BYOK_VERSION
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
  }
  catch {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    return `v${pkg.version}-dev`
  }
}

const version = JSON.stringify(resolveVersion())

await esbuild.build({
  entryPoints: [path.join(import.meta.dirname, '..', 'src', 'standalone.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(import.meta.dirname, '..', 'dist', 'server.cjs'),
  // no sourcemap: saves ~25MB of build output
  nodePaths: [vendorModules],
  external: ['@vakra-dev/supermarkdown'],
  define: {
    __BYOK_VERSION__: version,
    // the vendored /health handler references it through globalThis
    'globalThis.__BYOK_VERSION__': version,
  },
  logLevel: 'info',
})
console.log('[build] dist/server.cjs written')
