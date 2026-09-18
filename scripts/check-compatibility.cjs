#!/usr/bin/env node
/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */
"use strict";

const { readFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  MATRIX_PATH,
  computeCompatibilityMatrix,
} = require("./compatibility-matrix.cjs");

const repositoryRoot = resolve(__dirname, "..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function describeDifference(checkedIn, expected) {
  const contractKeys = ["protocol", "schema", "corpus", "identity"];
  for (const key of contractKeys) {
    if (!isDeepStrictEqual(checkedIn.contract?.[key], expected.contract[key])) {
      return `contract ${key} does not match the checked-in ${key === "identity" ? "components" : key}`;
    }
  }
  for (const implementation of expected.implementations) {
    const candidates = (checkedIn.implementations ?? []).filter(
      (candidate) => candidate.language === implementation.language,
    );
    if (candidates.length !== 1) {
      return `compatibility matrix must contain one ${implementation.language} entry`;
    }
    if (!isDeepStrictEqual(candidates[0], implementation)) {
      const label =
        implementation.language === "typescript" ? "TypeScript" : "Python";
      return `${label} parser metadata does not match the matrix`;
    }
  }
  return "compatibility matrix contains unexpected content";
}

async function checkLockMetadata() {
  const workspaceDirectories = ["parser", "graphics", "video", "react"];
  const workspaceLock = await readJson(
    resolve(repositoryRoot, "typescript/package-lock.json"),
  );
  const playgroundLock = await readJson(
    resolve(
      repositoryRoot,
      "typescript/examples/api-playground/package-lock.json",
    ),
  );
  for (const directory of workspaceDirectories) {
    const manifest = await readJson(
      resolve(repositoryRoot, `typescript/packages/${directory}/package.json`),
    );
    for (const [label, entry] of [
      ["workspace", workspaceLock.packages?.[`packages/${directory}`]],
      ["playground", playgroundLock.packages?.[`../../packages/${directory}`]],
    ]) {
      if (
        entry?.name !== manifest.name ||
        entry?.version !== manifest.version ||
        entry?.license !== manifest.license ||
        !isDeepStrictEqual(entry?.dependencies, manifest.dependencies)
      ) {
        throw new Error(
          `${label} lock metadata does not match ${manifest.name} ${manifest.version}`,
        );
      }
    }
  }
}

async function main() {
  const checkedIn = await readJson(resolve(repositoryRoot, MATRIX_PATH));
  if (checkedIn.contract?.protocol?.version_status !== "unversioned") {
    throw new Error("the protocol must remain explicitly unversioned");
  }
  const expected = await computeCompatibilityMatrix(repositoryRoot);
  if (!isDeepStrictEqual(checkedIn, expected)) {
    throw new Error(
      `${describeDifference(checkedIn, expected)}; run \`node scripts/sync-compatibility\` to regenerate ${MATRIX_PATH}`,
    );
  }
  await checkLockMetadata();

  const [typeScript, python] = expected.implementations;
  process.stdout.write(
    `compatibility: TypeScript ${typeScript.version}, Python ${python.version}, ` +
      `schema ${expected.contract.schema.schema_version}, ${expected.contract.corpus.case_count} cases, ` +
      "protocol unversioned\n",
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
