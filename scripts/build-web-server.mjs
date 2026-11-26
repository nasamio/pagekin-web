import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

fs.rmSync('dist-server', { recursive: true, force: true })
fs.mkdirSync('dist-server', { recursive: true })

const electronAliasPlugin = {
  name: 'electron-shim-alias',
  setup(buildCtx) {
    buildCtx.onResolve({ filter: /^electron$/ }, () => ({
      path: path.resolve('server/electron-module.ts'),
    }))
  },
}

const commonExternal = [
  'better-sqlite3',
  '@lancedb/lancedb',
  'apache-arrow',
  'flatbuffers',
  'yauzl',
]

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  plugins: [electronAliasPlugin],
  external: commonExternal,
  banner: {
    js: "import { createRequire as __pkRequire } from 'node:module'; if (!globalThis.require) globalThis.require = __pkRequire(import.meta.url);",
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})

await build({
  entryPoints: {
    'project-sqlite-worker': 'electron/services/project-sqlite-worker.ts',
    'portable-export-worker': 'electron/services/portable-export-worker.ts',
  },
  outdir: 'dist-server',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  plugins: [electronAliasPlugin],
  external: commonExternal,
  banner: {
    js: "import { createRequire as __pkRequire } from 'node:module'; if (!globalThis.require) globalThis.require = __pkRequire(import.meta.url);",
  },
  outExtension: { '.js': '.js' },
})

console.log('[build-web-server] Built dist-server/index.mjs + workers')
