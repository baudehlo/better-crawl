import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/sandbox/sandbox-runner.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'node',
});
