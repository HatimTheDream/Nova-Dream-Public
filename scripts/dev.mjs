import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/service/main.ts', '--dev'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); process.exitCode = code; }
for (const child of children) { child.on('error', () => stop(1)); child.on('exit', code => stop(code ?? 1)); }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
