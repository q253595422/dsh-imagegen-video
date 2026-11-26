/**
 * Visual-only entry for the dsh-imagegen settings card.
 *
 * Renders the real `ImageGenSettingsSection` against an in-memory settings
 * scope, so the beginner setup path and the service editor can be checked in a
 * real browser at the host's settings-pane width. No host routes are used.
 */

import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ImageGenSettingsCardController, ImageGenSettingsSection, type ImageGenSettingsCardState } from '../src/client/SettingsCard.tsx'
import { applyHostLocale } from '../src/client/helpers.ts'
import type { ImageGenConfig, ImageGenScope } from '../src/client/settings-scope.ts'

applyHostLocale('zh')

const variant = new URLSearchParams(location.search).get('state') === 'new' ? 'new' : 'configured'

const EMPTY: ImageGenConfig = {
  enabled: true,
  channels: [],
}

const CONFIGURED: ImageGenConfig = {
  enabled: true,
  announceToAgent: true,
  channels: [
    {
      id: 'volc',
      preset: 'volc-ark-seedream',
      name: '火山方舟（Seedream / Seedance）',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiUrlFull: false,
      models: [
        { alias: 'doubao-seedream-5-0-pro-260628', id: 'doubao-seedream-5-0-pro-260628' },
        { alias: 'doubao-seedream-5-0-260128', id: 'doubao-seedream-5-0-260128' },
        { alias: 'doubao-seedream-4-5-251128', id: 'doubao-seedream-4-5-251128' },
      ],
      videoModels: [
        { alias: 'doubao-seedance-2-0-260128', id: 'doubao-seedance-2-0-260128' },
        { alias: 'doubao-seedance-2-0-fast-260128', id: 'doubao-seedance-2-0-fast-260128' },
      ],
    },
    {
      id: 'openai',
      preset: 'openai-official',
      name: 'OpenAI 官方',
      apiUrl: 'https://api.openai.com/v1',
      apiUrlFull: false,
      models: [
        { alias: 'gpt-image-2.5', id: 'gpt-image-2.5' },
        { alias: 'gpt-image-2', id: 'gpt-image-2' },
      ],
    },
  ],
  defaultChannelId: 'volc',
  defaultModel: 'doubao-seedream-5-0-pro-260628',
  defaultVideoModel: 'doubao-seedance-2-0-260128',
  promptModel: 'deepseek-chat',
}

const config = variant === 'new' ? EMPTY : CONFIGURED
const secretIds = new Set(variant === 'new' ? [] : ['channelSecrets.volc', 'channelSecrets.openai'])

const scope = {
  getSnapshot: () => ({
    status: 'ready' as const,
    value: config,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }),
  subscribe: () => () => {},
  mutate: async () => {},
  set: async () => {},
  unset: async () => {},
  load: async () => {},
  mutateOps: async () => {},
  getKeySetSnapshot: (field: string) => secretIds.has(field),
  subscribeKeySet: () => () => {},
  getSecretSetSnapshot: (field: string) => secretIds.has(field),
  subscribeSecretSets: () => () => {},
} as unknown as ImageGenScope

const controller = new ImageGenSettingsCardController(scope)
const face = controller.inject()
const useImageGenSettingsCard = <T,>(selector: (snapshot: ImageGenSettingsCardState) => T): T => useSyncExternalStore(
  face.hooks.imageGenSettingsCard.subscribe,
  () => selector(face.hooks.imageGenSettingsCard.getSnapshot()),
)
const root = createRoot(document.getElementById('root')!)
root.render(createElement(ImageGenSettingsSection, {
  ...face,
  useImageGenSettingsCard,
} as never))
