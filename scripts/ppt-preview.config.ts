import { fileURLToPath } from 'node:url'
import configs from '../tsdown.config.ts'
export default {
  ...configs[1], name: 'ppt-preview',
  entry: { preview: fileURLToPath(new URL('./ppt-preview.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../.ppt-preview', import.meta.url)),
  format: 'iife', sourcemap: false, clean: true,
  deps: { alwaysBundle: ['react', 'react-dom', 'lucide-react'] },
  outputOptions: { entryFileNames: 'preview.js', banner: '', footer: '', intro: '' },
}
