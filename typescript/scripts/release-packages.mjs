/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

/**
 * The published packages in dependency order. A package may only depend on
 * packages that appear before it, so publishing in this order never leaves a
 * consumer resolving a version that does not exist yet.
 */
export const releasePackages = [
  { directory: 'parser', name: '@meta-sam/parser' },
  { directory: 'graphics', name: '@meta-sam/graphics' },
  { directory: 'video', name: '@meta-sam/video' },
  { directory: 'react', name: '@meta-sam/react' },
];

export const releasePackageByName = new Map(
  releasePackages.map((entry) => [entry.name, entry]),
);

export function isReleasePackageName(name) {
  return releasePackageByName.has(name);
}

export function isExactSemver(version) {
  if (typeof version !== 'string') return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  if (!match) return false;
  return !match[4]
    ?.split('.')
    .some((identifier) => /^\d+$/.test(identifier) && /^0\d/.test(identifier));
}

/**
 * Validates a `.changeset/release-plan.json` document and returns the selected
 * package entries in publication order.
 */
export function releasePackagesForPlan(plan) {
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.packages)) {
    throw new Error('Release plan must use schemaVersion 1 and contain packages.');
  }
  if (plan.packages.length === 0) {
    throw new Error('Release plan must contain at least one package.');
  }

  const selected = [];
  const seen = new Set();
  let previousIndex = -1;
  for (const planned of plan.packages) {
    const entry = releasePackageByName.get(planned?.name);
    if (!entry || !isExactSemver(planned.version)) {
      throw new Error(`Invalid planned package: ${JSON.stringify(planned)}.`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`Release plan contains duplicate package ${entry.name}.`);
    }
    const index = releasePackages.indexOf(entry);
    if (index <= previousIndex) {
      throw new Error('Release plan packages must follow dependency order.');
    }
    seen.add(entry.name);
    previousIndex = index;
    selected.push(entry);
  }
  return selected;
}
