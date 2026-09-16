import { copyFileSync, mkdirSync } from 'node:fs';
for (const plugin of ['worker-plugin', 'source-plugin', 'module-plugin']) {
  const target = `dist/service/apps/service/${plugin}`;
  mkdirSync(target, { recursive: true });
  for (const name of ['openclaw.plugin.json', 'package.json']) copyFileSync(`apps/service/${plugin}/${name}`, `${target}/${name}`);
}
