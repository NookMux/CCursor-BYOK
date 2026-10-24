/**
 * Entry point for the vendored Cursor++ server (from the vendor/CCursor copy).
 * The vendor tree is patched at bootstrap time (see patches/) so it runs standalone.
 */
import { initLogger } from '../vendor/CCursor/Cursor++/src/server/logger'
import { startProvidersWatcher, stopProvidersWatcher } from '../vendor/CCursor/Cursor++/src/server/config/providersStore'
import { startRoutesWatcher, stopRoutesWatcher } from '../vendor/CCursor/Cursor++/src/server/config/routesStore'
import { startServer, stopServer } from '../vendor/CCursor/Cursor++/src/server/index'

// injected by scripts/build.mjs via esbuild `define`
declare const __BYOK_VERSION__: string

const host = process.env.BYOK_HOST || '127.0.0.1'
const port = Number(process.env.BYOK_PORT || 39831)

// the IDE bridges these logs into its LogOutputChannel; standalone, mirror
// them to stdout so `docker logs` / journald sees startup + config events
initLogger((level, msg) => {
  const ts = new Date().toISOString()
  process.stdout.write(`${ts} [${level.toUpperCase()}] ${msg}\n`)
})

startServer({ host, port })
  .then((r) => {
    // no extension host around: watch the config files ourselves so edits to
    // providers.json / routes.json hot-reload, exactly like inside Cursor
    startProvidersWatcher()
    startRoutesWatcher()
    console.log(`[ccursor-server] v${__BYOK_VERSION__} listening on http://${r.host}:${r.port}`)
  })
  .catch((err) => {
    console.error('[ccursor-server] failed to start:', err)
    process.exit(1)
  })

// docker stop / ctrl-c: close the http server and sqlite cleanly instead of
// letting the default handler drop WAL mid-write
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopProvidersWatcher()
    stopRoutesWatcher()
    stopServer()
      .catch(err => console.error('[ccursor-server] shutdown error:', err))
      .finally(() => process.exit(0))
  })
}
