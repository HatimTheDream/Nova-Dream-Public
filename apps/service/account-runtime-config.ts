import { z } from 'zod';
import { chatGptAccountPluginId } from '../../packages/domain/chatgpt-accounts.js';

export function withAccountPlugin(raw: unknown, epoch: string, bundlePath: string, runtimeEntry: string) {
  const config = z.object({ plugins: z.object({ enabled: z.boolean().optional(), allow: z.array(z.string()).optional(), load: z.object({ paths: z.array(z.string()).optional() }).passthrough().optional(), entries: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() }).passthrough().parse(raw);
  const plugins = config.plugins ?? {};
  const previous = z.object({ enabled: z.boolean().optional(), config: z.object({ bundlePath: z.string().optional() }).passthrough().optional() }).passthrough().parse(plugins.entries?.[chatGptAccountPluginId] ?? {});
  if (plugins.enabled === false || previous.enabled === false) return config;
  return { ...config, plugins: { ...plugins, enabled: true, allow: [...new Set([...(plugins.allow ?? []), chatGptAccountPluginId])], load: { ...plugins.load, paths: [...new Set([...(plugins.load?.paths ?? []).filter(path => path !== previous.config?.bundlePath), bundlePath])] }, entries: { ...plugins.entries, [chatGptAccountPluginId]: { enabled: true, config: { epoch, bundlePath, runtimeEntry } } } } };
}
