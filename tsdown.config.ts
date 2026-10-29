import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
  dts: true,
  clean: true,
  // Emit lib/index.js + lib/index.d.ts (not .mjs/.d.mts): package.json is
  // "type": "module", and exports point at the .js/.d.ts filenames.
  fixedExtension: false,
})
