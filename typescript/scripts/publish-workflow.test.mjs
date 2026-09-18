/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { expect, test } from 'vitest';

import { changesetTagLines } from './publish-release-plan.mjs';

const actionRevision = 'a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d';
const actionUse = `changesets/action@${actionRevision}`;
const pinnedNewTagRegex = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/;
const setupNodeUse = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';

async function readYaml(relativePath) {
  return parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

const publishWorkflow = await readYaml('../../.github/workflows/release-npm.yml');
const validationWorkflow = await readYaml('../../.github/workflows/validate.yml');
const compatibilityWorkflow = await readYaml(
  '../../.github/workflows/media-compatibility.yml',
);
const actionContractBytes = await readFile(
  new URL(`./fixtures/changesets-action-${actionRevision}.yml`, import.meta.url),
);
const pinnedDistBytes = await readFile(
  new URL(
    `./fixtures/changesets-action-${actionRevision}-dist.js.txt`,
    import.meta.url,
  ),
);
const pinnedIndexBytes = await readFile(
  new URL(
    `./fixtures/changesets-action-${actionRevision}-index.ts.txt`,
    import.meta.url,
  ),
);
const pinnedGitBytes = await readFile(
  new URL(`./fixtures/changesets-action-${actionRevision}-git.ts.txt`, import.meta.url),
);
const pinnedRunBytes = await readFile(
  new URL(`./fixtures/changesets-action-${actionRevision}-run.ts.txt`, import.meta.url),
);
const actionContract = parse(actionContractBytes.toString('utf8'));
const pinnedDistSource = pinnedDistBytes.toString('utf8');
const pinnedIndexSource = pinnedIndexBytes.toString('utf8');
const pinnedGitSource = pinnedGitBytes.toString('utf8');
const pinnedRunSource = pinnedRunBytes.toString('utf8');
const publishReleasePlanSource = await readFile(
  new URL('./publish-release-plan.mjs', import.meta.url),
  'utf8',
);

function stepUsing(job, action) {
  return job.steps.find((step) => step.uses === action);
}

function stepNamed(job, name) {
  return job.steps.find((step) => step.name === name);
}

function expectNode24AndNpm11(job) {
  const setupIndex = job.steps.findIndex((step) => step.uses === setupNodeUse);
  const npmIndex = job.steps.findIndex(
    (step) => step.run === 'npm install --global npm@11.16.0',
  );
  const installIndex = job.steps.findIndex((step) => step.run === 'npm ci');
  expect(setupIndex).toBeGreaterThanOrEqual(0);
  expect(npmIndex).toBeGreaterThan(setupIndex);
  expect(installIndex).toBeGreaterThan(npmIndex);
  expect(job.steps[setupIndex]?.with).toMatchObject({
    'node-version': '24.18.0',
    cache: 'npm',
  });
  expect(job.steps[setupIndex]?.with?.['cache-dependency-path']).toContain(
    'typescript/package-lock.json',
  );
  expect(job.steps[npmIndex]?.name).toBe('Install npm 11');
}

function expectFfmpegBeforeMedia(job) {
  const ffmpegIndex = job.steps.findIndex(
    (step) =>
      step.run ===
      "scripts/ci-retry.sh sh -c 'sudo apt-get update && sudo apt-get install --yes ffmpeg'",
  );
  const mediaIndex = job.steps.findIndex(
    (step) =>
      typeof step.run === 'string' &&
      (step.run.includes('npm run test:browser') ||
        step.run.includes('npm run test:media-performance')),
  );
  expect(ffmpegIndex).toBeGreaterThanOrEqual(0);
  expect(mediaIndex).toBeGreaterThan(ffmpegIndex);
}

test('workflow shell commands run from the TypeScript workspace', () => {
  for (const workflow of [validationWorkflow, publishWorkflow, compatibilityWorkflow]) {
    expect(workflow.defaults?.run?.['working-directory']).toBe('typescript');
  }
  expect(stepNamed(validationWorkflow.jobs.validate, 'Validate')?.run).toBe(
    'node ../scripts/validate',
  );
});

test('publish paths include the TypeScript workspace and shared contracts', () => {
  expect(publishWorkflow.on.push.paths).toEqual(
    expect.arrayContaining([
      'typescript/.changeset/**',
      'typescript/package-lock.json',
      'typescript/packages/**',
      'protocol/**',
      'conformance/**',
    ]),
  );
  expect(publishWorkflow.on.push.paths).not.toContain('packages/**');
  expect(publishWorkflow.on.push.paths).not.toContain('.changeset/**');
});

test('artifact uploads use repository-root-relative TypeScript paths', () => {
  const uploadSteps = [
    validationWorkflow,
    publishWorkflow,
    compatibilityWorkflow,
  ].flatMap((workflow) =>
    Object.values(workflow.jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@')),
    ),
  );
  expect(uploadSteps.length).toBeGreaterThan(0);
  for (const step of uploadSteps) {
    const paths = step.with.path
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean);
    expect(paths.every((path) => path.startsWith('typescript/'))).toBe(true);
  }
});

test('every npm ci job installs exact Node and npm versions before dependencies', () => {
  const workflows = [
    ['validate', validationWorkflow],
    ['release-npm', publishWorkflow],
    ['media-compatibility', compatibilityWorkflow],
  ];
  const jobs = workflows.flatMap(([workflowName, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, job]) => job.steps.some((step) => step.run === 'npm ci'))
      .map(([jobName, job]) => ({ label: `${workflowName}/${jobName}`, job })),
  );
  expect(jobs.map(({ label }) => label).sort()).toEqual([
    'media-compatibility/codec-compatibility',
    'media-compatibility/react-mount-stress-100',
    'release-npm/browser-validation',
    'release-npm/publish',
    'release-npm/version',
    'validate/browser-media',
    'validate/media-performance',
    'validate/playground',
    'validate/playground-packed',
    'validate/validate',
  ]);
  for (const { job } of jobs) expectNode24AndNpm11(job);
});

test('every media workflow installs FFmpeg before verifying fixtures', () => {
  const jobs = [
    validationWorkflow.jobs['browser-media'],
    validationWorkflow.jobs['media-performance'],
    publishWorkflow.jobs['browser-validation'],
    compatibilityWorkflow.jobs['codec-compatibility'],
    compatibilityWorkflow.jobs['react-mount-stress-100'],
  ];
  for (const job of jobs) expectFfmpegBeforeMedia(job);
});

test('the checked action contract is the downloaded pinned action.yml', () => {
  expect(createHash('sha256').update(actionContractBytes).digest('hex')).toBe(
    '92cb9f17346aacabda72ae5e13ba92be3879be4d2887bbf7bd3c62bcfd030b54',
  );
  expect(Object.keys(actionContract.outputs)).toContain('hasChangesets');
  expect(Object.keys(actionContract.inputs)).toEqual(
    expect.arrayContaining([
      'cwd',
      'version',
      'commit',
      'title',
      'branch',
      'publish',
      'createGithubReleases',
      'commitMode',
    ]),
  );
});

test('the pinned github-api mode creates tags at context.sha without local tags', () => {
  expect(createHash('sha256').update(pinnedDistBytes).digest('hex')).toBe(
    'fbe7cc3e082c35495dead85bbe6a057c4c59cae6d0170a20c64846b0d5ae1b82',
  );
  expect(createHash('sha256').update(pinnedIndexBytes).digest('hex')).toBe(
    '91099d3fc3dd43e28c32d9a97052f8db178592ed80f81a52d4bf5126c9b64ad2',
  );
  expect(createHash('sha256').update(pinnedGitBytes).digest('hex')).toBe(
    '374b56c160d141d011b7dbfbdd98548d7e6cfe1e769e581768e36e0371727f4b',
  );
  expect(createHash('sha256').update(pinnedRunBytes).digest('hex')).toBe(
    '6b609dc089c32327bbce7d899f663baad0327d2f52c5bd60926bac07c213cd95',
  );
  expect(pinnedDistSource).toContain('octokit:o===`github-api`?a:void 0');
  expect(pinnedDistSource).toContain('ref:`refs/tags/${e}`,sha:f.sha');
  expect(pinnedDistSource).toContain(
    'await p(`git`,[`push`,`origin`,e],{cwd:this.cwd})',
  );
  expect(pinnedIndexSource).toContain(
    'octokit: commitMode === "github-api" ? octokit : undefined',
  );
  expect(pinnedIndexSource).toContain(
    'commitMode !== "git-cli" && commitMode !== "github-api"',
  );
  expect(pinnedRunSource).toContain('await git.pushTag(tagName);');
  expect(pinnedGitSource).toContain('if (this.octokit) {');
  expect(pinnedGitSource).toContain('.createRef({');
  expect(pinnedGitSource).toContain('ref: `refs/tags/${tag}`');
  expect(pinnedGitSource).toContain('sha: github.context.sha');
  expect(pinnedGitSource).toContain(
    'await exec("git", ["push", "origin", tag], { cwd: this.cwd });',
  );

  const action = stepUsing(publishWorkflow.jobs.publish, actionUse);
  expect(action.with.commitMode).toBe('github-api');
  const modeled =
    action.with.commitMode === 'github-api'
      ? {
          apiRef: 'refs/tags/@meta-sam/parser@0.0.2',
          localTagPushes: [],
          sha: 'github.context.sha',
        }
      : {
          apiRef: null,
          localTagPushes: ['@meta-sam/parser@0.0.2'],
          sha: null,
        };
  expect(modeled).toEqual({
    apiRef: 'refs/tags/@meta-sam/parser@0.0.2',
    localTagPushes: [],
    sha: 'github.context.sha',
  });
});

test('publish output matches the pinned Changesets action parser exactly', () => {
  const lines = changesetTagLines(
    {
      packages: [{ name: '@meta-sam/parser', version: '0.0.2' }],
    },
    'Already published and verified @meta-sam/parser@0.0.2\n',
  );
  expect(lines).toEqual(['New tag: @meta-sam/parser@0.0.2']);
  expect(lines[0].match(pinnedNewTagRegex)?.slice(1)).toEqual([
    '@meta-sam/parser',
    '0.0.2',
  ]);
  expect(publishReleasePlanSource).not.toContain('CHANGESETS_OUTPUT');
});

test('manual publication is gated to main and skipped dependencies cannot run', () => {
  const version = publishWorkflow.jobs.version;
  expect(version.if).toBe(
    "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'",
  );

  const versionRuns = ({ eventName, ref }) =>
    eventName !== 'workflow_dispatch' || ref === 'refs/heads/main';
  expect(
    [
      { eventName: 'push', ref: 'refs/heads/main' },
      { eventName: 'workflow_dispatch', ref: 'refs/heads/main' },
      { eventName: 'workflow_dispatch', ref: 'refs/heads/recovery-test' },
    ].map(versionRuns),
  ).toEqual([true, true, false]);

  expect(publishWorkflow.jobs['browser-validation'].needs).toBe('version');
  expect(publishWorkflow.jobs.publish.needs).toContain('version');
  expect(publishWorkflow.jobs['browser-validation'].if).not.toContain('always()');
  expect(publishWorkflow.jobs.publish.if).not.toContain('always()');
});

test('main updates a rolling Changesets release pull request with supported inputs', () => {
  expect(publishWorkflow.on.push.branches).toContain('main');
  const job = publishWorkflow.jobs.version;
  const action = stepUsing(job, actionUse);
  expect(action).toBeDefined();
  expect(action.id).toBe('changesets');
  expect(action.with).toEqual({
    cwd: 'typescript',
    version: 'npm run version-packages',
    commit: 'chore: version packages',
    title: 'chore: version packages',
    branch: 'main',
    createGithubReleases: false,
  });
  expect(job.outputs.hasChangesets).toBe(
    '${{ steps.changesets.outputs.hasChangesets }}',
  );
});

test('every Changesets action input exists in the pinned action contract', () => {
  const validInputs = new Set(Object.keys(actionContract.inputs));
  const actionSteps = Object.values(publishWorkflow.jobs).flatMap((job) =>
    job.steps.filter((step) => step.uses === actionUse),
  );
  expect(actionSteps).toHaveLength(2);
  for (const step of actionSteps) {
    for (const input of Object.keys(step.with ?? {})) {
      expect(validInputs.has(input), `${input} must be declared by action.yml`).toBe(
        true,
      );
    }
  }
});

test('publication consumes the reviewed release plan and preserves tag output', () => {
  const publishJob = publishWorkflow.jobs.publish;
  expect(publishJob.needs).toEqual(['version', 'browser-validation']);
  expect(publishJob.if).toBe("needs.version.outputs.hasChangesets == 'false'");
  expect(stepNamed(publishJob, 'Check for a reviewed release plan')).toBeDefined();
  const action = stepUsing(publishJob, actionUse);
  expect(action.with).toEqual({
    cwd: 'typescript',
    publish: 'npm run release:npm',
    commitMode: 'github-api',
    createGithubReleases: true,
  });
  // The pinned action prefers NPM_TOKEN and falls back to OIDC trusted
  // publishing when the variable is empty; the publish job passes the
  // environment secret through under that exact name.
  expect(action.env).toEqual({ NPM_TOKEN: '${{ secrets.NPM_TOKEN }}' });
  expect(pinnedIndexSource).toContain('if (process.env.NPM_TOKEN)');
  expect(pinnedIndexSource).toContain('using npm trusted publishing');
  expect(publishWorkflow.jobs['browser-validation'].if).toBe(
    "needs.version.outputs.hasChangesets == 'false'",
  );
});

test('publication runs inside the protected npm environment without stored registry credentials', () => {
  const publishJob = publishWorkflow.jobs.publish;
  expect(publishJob.environment).toBe('npm');
  expect(publishJob.permissions).toEqual({
    actions: 'read',
    contents: 'write',
    'id-token': 'write',
  });
  const setupNode = stepUsing(publishJob, setupNodeUse);
  expect(setupNode.with['registry-url']).toBeUndefined();
  const workflowSource = JSON.stringify(publishWorkflow);
  expect(workflowSource).not.toMatch(/registry\.facebook\.net|internalfb|crypto_jwt/);
  expect(workflowSource).not.toContain('NPM_CONFIG_USERCONFIG');
});

test('publish waits for the packed gate and both required Chromium media gates', () => {
  const validation = publishWorkflow.jobs['browser-validation'];
  expectNode24AndNpm11(validation);
  const playwrightIndex = validation.steps.findIndex(
    (step) =>
      step.run === 'scripts/ci-retry.sh npx playwright install --with-deps chromium',
  );
  const ffmpegIndex = validation.steps.findIndex(
    (step) =>
      step.run ===
      "scripts/ci-retry.sh sh -c 'sudo apt-get update && sudo apt-get install --yes ffmpeg'",
  );
  const packedIndex = validation.steps.findIndex(
    (step) => step.run === 'npm run playground:test:packed',
  );
  expect(playwrightIndex).toBeGreaterThanOrEqual(0);
  expect(ffmpegIndex).toBeGreaterThanOrEqual(0);
  expect(packedIndex).toBeGreaterThan(playwrightIndex);
  expect(packedIndex).toBeGreaterThan(ffmpegIndex);
  expect(stepNamed(validation, 'Run required browser validation')?.run).toBe(
    'npm run test:browser -- --project=chromium',
  );
  expect(stepNamed(validation, 'Run required media performance validation')?.run).toBe(
    'npm run test:media-performance -- --project=chromium',
  );
});

test('OIDC authority remains confined to the publish job', () => {
  const privileged = Object.entries(publishWorkflow.jobs)
    .filter(([, job]) => job.permissions?.['id-token'] === 'write')
    .map(([name]) => name);
  expect(privileged).toEqual(['publish']);
});

test('pull requests declare release intent and run required media jobs', () => {
  expect(validationWorkflow.on.pull_request).toBeNull();
  expect(validationWorkflow.jobs.validate.steps[0].with['fetch-depth']).toBe(0);
  expect(
    stepNamed(validationWorkflow.jobs.validate, 'Check release intent'),
  ).toMatchObject({
    if: "github.event_name == 'pull_request' && github.head_ref != 'changeset-release/main'",
    run: `${[
      'npm run changeset:check -- --base=origin/main',
      'npm run changeset:status -- --since=origin/main',
    ].join('\n')}\n`,
  });

  const browser = validationWorkflow.jobs['browser-media'];
  const performance = validationWorkflow.jobs['media-performance'];
  expectNode24AndNpm11(browser);
  expectNode24AndNpm11(performance);
  expect(stepNamed(browser, 'Run required browser media tests')?.run).toBe(
    'npm run test:browser -- --project=chromium',
  );
  expect(stepNamed(performance, 'Run stable media performance gates')?.run).toBe(
    'npm run test:media-performance -- --project=chromium',
  );
});

test('the playground job validates its isolated install, build, unit, and browser lanes', () => {
  const playground = validationWorkflow.jobs.playground;
  expectNode24AndNpm11(playground);
  expect(stepNamed(playground, 'Install playground dependencies')?.run).toBe(
    'npm ci --prefix examples/api-playground',
  );
  expect(stepNamed(playground, 'Build playground')?.run).toBe(
    'npm run playground:build',
  );
  expect(stepNamed(playground, 'Run playground unit tests')?.run).toBe(
    'npm run test --prefix examples/api-playground',
  );
  expect(stepNamed(playground, 'Install Playwright Chromium')?.run).toBe(
    'cd examples/api-playground && ../../scripts/ci-retry.sh npx playwright install --with-deps chromium',
  );
  expect(stepNamed(playground, 'Run playground browser tests')?.run).toBe(
    'npm run playground:test:browser',
  );
  expect(playground.steps[1].with['cache-dependency-path']).toContain(
    'typescript/examples/api-playground/package-lock.json',
  );
});

test('the packed playground job uses release-shaped production validation', () => {
  const packed = validationWorkflow.jobs['playground-packed'];
  expect(packed.needs).toBe('validate');
  expectNode24AndNpm11(packed);

  const playwrightIndex = packed.steps.findIndex(
    (step) =>
      step.run === 'scripts/ci-retry.sh npx playwright install --with-deps chromium',
  );
  const ffmpegIndex = packed.steps.findIndex(
    (step) =>
      step.run ===
      "scripts/ci-retry.sh sh -c 'sudo apt-get update && sudo apt-get install --yes ffmpeg'",
  );
  const gateIndex = packed.steps.findIndex(
    (step) => step.run === 'npm run playground:test:packed',
  );
  expect(playwrightIndex).toBeGreaterThanOrEqual(0);
  expect(ffmpegIndex).toBe(-1);
  expect(gateIndex).toBeGreaterThan(playwrightIndex);
});

test('scheduled compatibility covers Chromium, Chrome, artifacts, and deep React stress', () => {
  expect(compatibilityWorkflow.on.schedule).toHaveLength(1);
  expect(compatibilityWorkflow.on.workflow_dispatch).toBeNull();
  const compatibility = compatibilityWorkflow.jobs['codec-compatibility'];
  const deepStress = compatibilityWorkflow.jobs['react-mount-stress-100'];
  expectNode24AndNpm11(compatibility);
  expectNode24AndNpm11(deepStress);
  expect(compatibility.strategy.matrix.include).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ project: 'chromium', install: 'chromium' }),
      expect.objectContaining({ project: 'chrome', install: 'chrome' }),
    ]),
  );
  expect(stepNamed(compatibility, 'Upload codec capability artifact')).toBeDefined();
  expect(stepNamed(deepStress, 'Run 100-cycle React mount stress lane')?.env).toEqual({
    MEDIA_REACT_STRESS_CYCLES: '100',
  });
});
