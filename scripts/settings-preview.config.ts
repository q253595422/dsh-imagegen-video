import { fileURLToPath } from 'node:url'
import configs from '../tsdown.config.ts'

const client = configs[1]

export default {
  ...client,
  name: 'settings-preview',
  entry: { preview: fileURLToPath(new URL('./settings-preview.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../.settings-preview', import.meta.url)),
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
  clean: true,
  deps: {
    neverBundle: [],
    alwaysBundle: ['react', 'react-dom', 'lucide-react', '@deepseek-ai/dsh-client-ui-primitives', 'clsx'],
  },
  outputOptions: { entryFileNames: 'preview.js', banner: '', footer: '' },
}
