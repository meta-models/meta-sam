/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const REACT_PACKAGES = ['react', 'react-dom'] as const;

function packageRoot(moduleId: string, packageName: string): string | null {
  const normalized = moduleId.replaceAll('\\', '/').replace(/^\0+/, '');
  const marker = `/node_modules/${packageName}/`;
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex === -1
    ? null
    : normalized.slice(0, markerIndex + marker.length - 1);
}

function assertReactSingleton(): Plugin {
  return {
    name: 'assert-react-singleton',
    generateBundle(_options, bundle) {
      for (const packageName of REACT_PACKAGES) {
        const roots = new Set<string>();
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue;
          for (const moduleId of Object.keys(output.modules)) {
            const root = packageRoot(moduleId, packageName);
            if (root !== null) roots.add(root);
          }
        }
        if (roots.size > 1) {
          this.error(
            `${packageName} resolved from multiple package roots:\n${[...roots].join('\n')}`,
          );
        }
      }
    },
  };
}

export default defineConfig({
  resolve: {
    // File dependencies can be reached through /tmp and /private/tmp on macOS.
    // Always resolve hooks and renderers against the playground React singleton.
    dedupe: [...REACT_PACKAGES],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    exclude: ['@meta-sam/react'],
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', { target: '19' }]],
      },
    }),
    assertReactSingleton(),
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,mjs}'],
  },
});
