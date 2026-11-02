import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, stat } from 'node:fs/promises'

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' }

// The Swift helper that finds what is on screen (native/sense.swift). It needs Xcode's command-line tools; without
// them screen-ink still runs, and marks fall back to the model's guessed coordinates.
async function senseHelper() {
  if (process.platform !== 'darwin') return
  const src = 'native/sense.swift'
  const out = 'dist/screen-ink-sense'
  const built = await stat(out).catch(() => null)
  if (built && built.mtimeMs >= (await stat(src)).mtimeMs) return
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13`
  await new Promise(resolve =>
    execFile('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', target, '-o', out, src], (err, _stdout, stderr) => {
      if (err) console.warn(`screen-ink-sense wasn't built, so marks will use guessed coordinates:\n${stderr || err.message}`)
      else console.log(`  ${out}`)
      resolve()
    }),
  )
}

await mkdir('dist/renderer', { recursive: true })
await Promise.all([
  // Main and preload stay CommonJS and load npm packages from node_modules at runtime.
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', packages: 'external' }),
  ...['preload', 'ask-preload', 'settings-preload'].map(name =>
    build({ ...common, entryPoints: [`src/main/${name}.ts`], outfile: `dist/${name}.js`, platform: 'node', format: 'cjs', external: ['electron'] }),
  ),
  ...['renderer', 'ask', 'settings'].map(name =>
    build({ ...common, entryPoints: [`src/renderer/${name}.ts`], outfile: `dist/renderer/${name}.js`, platform: 'browser', format: 'iife' }),
  ),
  copyFile('src/renderer/index.html', 'dist/renderer/index.html'),
  copyFile('src/renderer/ask.html', 'dist/renderer/ask.html'),
  copyFile('src/renderer/settings.html', 'dist/renderer/settings.html'),
  senseHelper(),
])
