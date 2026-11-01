import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' }

await mkdir('dist/renderer', { recursive: true })
await Promise.all([
  // Main and preload stay CommonJS and load npm packages from node_modules at runtime.
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', packages: 'external' }),
  ...['preload', 'ask-preload'].map(name =>
    build({ ...common, entryPoints: [`src/main/${name}.ts`], outfile: `dist/${name}.js`, platform: 'node', format: 'cjs', external: ['electron'] }),
  ),
  ...['renderer', 'ask'].map(name =>
    build({ ...common, entryPoints: [`src/renderer/${name}.ts`], outfile: `dist/renderer/${name}.js`, platform: 'browser', format: 'iife' }),
  ),
  copyFile('src/renderer/index.html', 'dist/renderer/index.html'),
  copyFile('src/renderer/ask.html', 'dist/renderer/ask.html'),
])
