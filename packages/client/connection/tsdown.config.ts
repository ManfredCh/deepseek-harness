import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  dualClient: true,
  companions: [{ entry: ['lib/types/node.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false }],
})
