/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

type RenderCounts = Record<string, number>;

declare global {
  interface Window {
    __playgroundRenders?: RenderCounts;
  }
}

const isFixture = new URLSearchParams(window.location.search).has('fixture');

export function countRender(component: string): void {
  if (!isFixture) return;
  const counts = (window.__playgroundRenders ??= {});
  counts[component] = (counts[component] ?? 0) + 1;
}
