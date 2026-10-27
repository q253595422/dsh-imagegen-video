/** Real components with deterministic service fixtures; no model calls. */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { PptWorkspace } from '../src/client/PptWorkspace.tsx'
import { PptSetup } from '../src/client/PptSetup.tsx'
import type { ImageGenApi } from '../src/client/api.ts'
import type { CanvasSkillTask } from '../src/protocol.ts'

const assets = [1, 2].map(index => ({ assetId: `slide-${index}.png`, url: '/slide.png', mime: 'image/png', bytes: 100, width: 1600, height: 900, origin: 'upload' as const, name: `AI-planning-${index}.png` }))
let task: CanvasSkillTask | undefined
let previewAttempts = 0
const api = {
  async canvasFileUpload(file: File) { return { ...assets[0], name: file.name } },
  async canvasFilePreview(asset: { assetId: string }) { if (asset.assetId === 'preview-retry.pptx' && previewAttempts++ === 0) throw new Error('Preview temporarily unavailable'); return { kind: 'slides', format: 'pptx', slides: [{ title: 'AI PLATFORM ROADMAP', lines: ['Editable presentation content', 'Knowledge → Workflow → Intelligence'], images: [] }, { title: 'NEXT STEPS', lines: ['Review the generated PPT in PowerPoint'], images: [] }], truncated: false } },
  async pptTasks() { return task ? [task] : [] },
  async canvasSkillsList() { return { skills: [], installed: ['image-to-editable-ppt'], agentAvailable: true, registryAvailable: true } },
  async canvasSkillLibrary() { return { entries: [{ name: 'image-to-editable-ppt', config: { values: [{ id: 'paddle-ocr-token', set: true }] } }] } },
  async pptRun(request: { images: typeof assets }) {
    task = { id: 'ppt-preview', canvasId: 'ppt', skillId: 'ppt.fromImages', label: 'PPT', tier: 'heavy', status: 'running', startedAt: Date.now() - 104000, pptImages: request.images, stage: '正在执行技能流程', progress: { lastActivityAt: Date.now() - 75000, currentOperation: '正在执行工具：shell · 正在处理页面文字提示', pages: [{ page: 1, state: 'validated' }, { page: 2, state: 'running' }], events: [{ time: Date.now() - 104000, label: '正在准备输入图片', state: 'done' }, { time: Date.now() - 75000, label: '正在执行工具：shell · 正在处理页面文字提示', state: 'running' }] } }
    return task
  },
  async canvasSkillCancel() { if (task) task = { ...task, status: 'cancelled', stage: '已取消' }; return true },
} as unknown as ImageGenApi
function Preview() {
  const [importRequest, setImport] = useState<{ id: number; file: File }>()
  const [setup, setSetup] = useState(false)
  return <div className="fixture"><header><strong>生图工作室 · 图片转 PPT</strong><span>组件样式预览 · 示例数据</span>
    <button onClick={() => setSetup(!setup)}>切换配置页</button>
    <button onClick={() => {
      task = { id: 'ppt-preview', canvasId: 'ppt', skillId: 'ppt.fromImages', label: 'PPT', tier: 'heavy', status: 'completed', startedAt: Date.now() - 204000, pptImages: assets, stage: '转换完成', output: { nodes: [{ id: 'deck', type: 'file', title: 'editable-deck.pptx', x: 0, y: 0, width: 300, height: 170, metadata: { asset: { ...assets[0], assetId: 'deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', name: 'editable-deck.pptx', url: '/deck.pptx' } } }, { id: 'preview', type: 'file', title: 'preview.png', x: 0, y: 0, width: 300, height: 170, metadata: { asset: { ...assets[0], name: 'preview.png' } } }], connections: [], warnings: [] } }
    }}>示例完成</button>
    <button onClick={() => { if (task?.output) task = { ...task, status: 'completed', output: { ...task.output, nodes: task.output.nodes.slice(0, 1).map(node => ({ ...node, metadata: { ...node.metadata, asset: { ...node.metadata!.asset!, assetId: 'preview-retry.pptx' } } })) } } }}>示例预览重试</button>
    <button onClick={() => { if (task) task = { ...task, status: 'failed', output: undefined, error: 'Model API returned 401', agentSessionId: 'skillagent-preview', runDirectory: '/example/ppt/run' } }}>示例失败</button>
    <button onClick={() => { task = undefined }}>清空示例</button>
  </header>{setup ? <main className="settings"><h2>图片转可编辑 PPT 配置</h2><PptSetup /></main> : <main><PptWorkspace api={api} active importRequest={importRequest} onImported={() => setImport(undefined)} /></main>}</div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
