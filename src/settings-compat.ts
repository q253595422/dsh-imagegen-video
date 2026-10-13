/** Compatibility helpers for the dsh-settings API transition. */

import type { Context } from '@deepseek-ai/cordis'
import * as settingsModule from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

type SettingsModuleCompat = {
  settingsNamespace?: (value: string) => SettingsNamespace
  installSettingsSection?: <T>(
    ctx: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ) => void
}

interface SettingsProviderCompat {
  configure?: (
    presentation: { auto?: boolean },
    owner?: unknown,
  ) => (() => void) | void
  installSection?: <T>(
    owner: Context,
    ns: SettingsNamespace,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ) => void
}

const compatModule = settingsModule as unknown as SettingsModuleCompat

/** Strip volatile markers for the pre-0.1.7 settings providers. */
function plainSettingsSchema<T>(schema: z<T>): z<T> {
  const clone = schema.toJSON()
  const seen = new WeakSet<object>()
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return
    seen.add(node)
    const record = node as Record<string, unknown>
    const meta = record.meta
    if (typeof meta === 'object' && meta !== null) delete (meta as { volatile?: boolean }).volatile
    if (typeof record.dict === 'object' && record.dict !== null) {
      for (const child of Object.values(record.dict as Record<string, unknown>)) walk(child)
    }
    walk(record.inner)
    walk(record.sKey)
    if (Array.isArray(record.list)) for (const child of record.list) walk(child)
  }
  walk(clone)
  return clone
}

/** The loader entry id of the plugin instance owning `ctx`, when available. */
function entryNamespaceOf(ctx: Context): SettingsNamespace | undefined {
  const compat = ctx as unknown as {
    fiber?: { entry?: { id?: unknown; options?: { id?: unknown } } }
    loader?: { locate?: (fiber?: unknown) => unknown }
  }
  const entry = compat.fiber?.entry
  const candidates = [
    entry?.options?.id,
    entry?.id,
    compat.loader?.locate?.(compat.fiber),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate as SettingsNamespace
  }
  return undefined
}

/** Brand namespaces where the installed settings package still exposes it. */
export function settingsNamespaceCompat(value: string): SettingsNamespace {
  return compatModule.settingsNamespace?.(value) ?? value as SettingsNamespace
}

/**
 * Resolve the namespace the settings bridge must read and write.
 *
 * Older settings providers register a caller-chosen namespace through the
 * module helper or `provider.installSection`. The managed-forms provider used
 * by DSH 0.1.7 derives forms from the plugin's profile entry instead, so its
 * namespace is the entry id (`imagegen`) rather than the legacy display id
 * (`dsh-imagegen`). The bridge keeps the legacy id on its public wire contract
 * and translates it to this internal namespace.
 */
export function resolveSettingsNamespaceCompat(
  ctx: Context,
  provider: unknown,
  fallback: SettingsNamespace,
): SettingsNamespace {
  if (compatModule.installSettingsSection !== undefined) return fallback
  const candidate = provider as SettingsProviderCompat
  if (candidate.installSection !== undefined) return fallback
  if (candidate.configure !== undefined) return entryNamespaceOf(ctx) ?? fallback
  return fallback
}

/**
 * Register an optional settings section across the rc.7, alpha.2 and managed
 * forms APIs. The first two expose an installer; 0.1.7 derives forms directly
 * from the plugin's volatile Config and only needs the custom-page policy.
 */
export function installSettingsSectionCompat<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const legacyInstaller = compatModule.installSettingsSection
  if (legacyInstaller !== undefined) {
    legacyInstaller(ctx, ns, plainSettingsSchema(schema), entry, hooks)
    return
  }

  ctx.inject(['settings'], (sctx) => {
    const provider = sctx.get('settings') as unknown as SettingsProviderCompat
    if (provider.installSection !== undefined) {
      provider.installSection(ctx, ns, plainSettingsSchema(schema), entry, hooks)
      return
    }
    if (provider.configure === undefined) {
      throw new TypeError('dsh-settings does not expose installSection or configure')
    }
    // 0.1.7 derives editable forms from the plugin's volatile Config. The
    // custom card below replaces the optional auto-generated page; the plugin
    // keeps a live Config reference, so no setSource hook is needed.
    sctx.effect(() => {
      const dispose = provider.configure?.({ auto: false }, ctx.fiber)
      return typeof dispose === 'function' ? dispose : () => {}
    })
    const namespace = entryNamespaceOf(ctx)
    if (namespace !== undefined) {
      const settingsEvents = sctx as unknown as {
        on(event: 'settings/document-updated', listener: (updated: unknown) => void): () => void
      }
      sctx.effect(() => settingsEvents.on('settings/document-updated', (updated) => {
        if (String(updated) === namespace) hooks.onChange()
      }))
    }
  })
}
