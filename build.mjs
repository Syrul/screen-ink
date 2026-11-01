import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' }

await mkdir('dist/renderer', { recursive: true })
await Promise.all([
  // Main and preload stay CommonJS and load npm packages from node_modules at runtime.
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', packages: 'external' }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' }),
  copyFile('src/renderer/index.html', 'dist/renderer/index.html'),
])
