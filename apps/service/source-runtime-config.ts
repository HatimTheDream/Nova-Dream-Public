import { z } from 'zod';
import { sourcePluginId } from '../../packages/domain/source-transfer.js';

export function withSourcePlugin(raw: unknown, epoch: string, bundlePath: string, cacheDirectory: string) {
  const config = z.object({ plugins: z.object({ enabled: z.boolean().optional(), allow: z.array(z.string()).optional(), load: z.object({ paths: z.array(z.string()).optional() }).passthrough().optional(), entries: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() }).passthrough().parse(raw);
  const plugins = config.plugins ?? {};
  const previous = z.object({ enabled: z.boolean().optional(), config: z.object({ bundlePath: z.string().optional() }).passthrough().optional() }).passthrough().parse(plugins.entries?.[sourcePluginId] ?? {});
  // Respect an explicitly disabled adapter. Small text sources still work.
  if (plugins.enabled === false || previous.enabled === false) return config;
  return { ...config, plugins: { ...plugins, enabled: true, allow: [...new Set([...(plugins.allow ?? []), sourcePluginId, 'document-extract'])], load: { ...plugins.load, paths: [...new Set([...(plugins.load?.paths ?? []).filter(path => path !== previous.config?.bundlePath), bundlePath])] }, entries: { ...plugins.entries, [sourcePluginId]: { enabled: true, config: { epoch, bundlePath, cacheDirectory } } } } };
}
