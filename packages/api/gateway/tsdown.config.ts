import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-api-gateway', ['lib/types/index.js'], {
  companions: [{ entry: ['lib/types/node.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false }],
})
