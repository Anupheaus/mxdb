import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    client: 'src/client/index.ts',
    server: 'src/server/index.ts',
    common: 'src/common/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: 'es2022',
});
