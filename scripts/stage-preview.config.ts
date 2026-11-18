/**
 * 导演台全屏面板的视觉验收构建。
 *
 * 与 `studio-preview.config.ts` 共用同一个客户端基础配置，只改三处：
 * 入口、输出目录、产物名。这样 CSS Module、主题 token、three 的内联规则、
 * 普通 `.css` 的桩全都只有一份定义——两份配置各写一遍的话，改了一处漏了
 * 另一处，症状是「生图预览正常、导演台预览白屏」，而两者应该永远一致。
 *
 * Build: `pnpm stage:preview` → `.studio-stage/stage.js`
 */
import { fileURLToPath } from 'node:url'
import studioPreview from './studio-preview.config.ts'

export default {
  ...studioPreview,
  name: 'stage-preview',
  entry: { stage: fileURLToPath(new URL('./stage-preview.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../.studio-stage', import.meta.url)),
  outputOptions: { ...studioPreview.outputOptions, entryFileNames: 'stage.js' },
}
