// A daemon in a process of its own, on the mock agy, for tests that run two
// instances side by side. Prints one JSON line (port, auth key, the plugin's
// provider id and default state dir as this process sees them), then serves
// until stdin closes.
import path from "node:path"
import { startDaemon } from "../src/daemon.mjs"
import { PROVIDER_ID } from "../src/plugin.mjs"
import { defaultStateDir } from "../src/state-security.mjs"

const MOCK_AGY = path.resolve(import.meta.dir, "mock-agy.mjs")
const stateDir = process.argv[2]
const d = await startDaemon({ stateDir, findAgy: () => MOCK_AGY, skipSignInCheck: true, skipInfoFile: true, exitOnShutdown: false })
d.bridge.geminiDir = null
console.log(JSON.stringify({ port: d.port, authKey: d.authKey, providerId: PROVIDER_ID, defaultStateDir: defaultStateDir() }))
process.stdin.resume()
process.stdin.on("end", async () => {
  await d.shutdown()
  process.exit(0)
})
