#!/usr/bin/env node
/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { extname, resolve } = require("node:path");
const { readFileSync } = require("node:fs");

const repositoryRoot = resolve(__dirname, "..");
const EXPECTED_LICENSE_SHA256 =
  "4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be";
const PACKAGE_LICENSE = "SEE LICENSE IN LICENSE";
const SAM_HEADER =
  "Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.";
const licensePaths = Object.freeze([
  "LICENSE",
  "python/LICENSE",
  "typescript/packages/parser/LICENSE",
  "typescript/packages/graphics/LICENSE",
  "typescript/packages/video/LICENSE",
  "typescript/packages/react/LICENSE",
]);
const manifestPaths = Object.freeze([
  "typescript/package.json",
  "typescript/packages/parser/package.json",
  "typescript/packages/graphics/package.json",
  "typescript/packages/video/package.json",
  "typescript/packages/react/package.json",
  "typescript/examples/api-playground/package.json",
]);
const lockPolicies = Object.freeze([
  {
    path: "typescript/package-lock.json",
    owned: [
      "",
      "packages/parser",
      "packages/graphics",
      "packages/video",
      "packages/react",
    ],
  },
  {
    path: "typescript/examples/api-playground/package-lock.json",
    owned: [
      "",
      "../../packages/parser",
      "../../packages/graphics",
      "../../packages/video",
      "../../packages/react",
    ],
  },
]);
const headerExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".mjs",
  ".py",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
// Files that reproduce third-party license text verbatim, as those licenses
// require. They are the only tracked files allowed to name another license.
const thirdPartyNoticeFiles = new Set(["THIRD_PARTY_NOTICES.md"]);
const copiedThirdPartyFixtures = new Set([
  "typescript/scripts/fixtures/changesets-action-a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d-dist.js.txt",
  "typescript/scripts/fixtures/changesets-action-a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d-git.ts.txt",
  "typescript/scripts/fixtures/changesets-action-a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d-index.ts.txt",
  "typescript/scripts/fixtures/changesets-action-a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d-run.ts.txt",
  "typescript/scripts/fixtures/changesets-action-a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d.yml",
]);
const lockPaths = new Set(lockPolicies.map(({ path }) => path));
const consumedPendingChangesetPath =
  /^typescript\/\.changeset\/(?!README\.md$)[^/]+\.md$/;
const legacyLicensePattern = new RegExp(`\\b${"M" + "IT"}\\b`, "i");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertLicenseBytes(content, label) {
  const digest = sha256(content);
  if (digest !== EXPECTED_LICENSE_SHA256) {
    throw new Error(
      `${label} has sha256 ${digest}, expected ${EXPECTED_LICENSE_SHA256}.`,
    );
  }
}

function assertManifestLicense(manifest, label) {
  if (manifest.license !== PACKAGE_LICENSE) {
    throw new Error(
      `${label} must declare ${JSON.stringify(PACKAGE_LICENSE)}.`,
    );
  }
}

function findStaleLicenseDeclaration(content) {
  return legacyLicensePattern.test(content);
}

function trackedFiles(root = repositoryRoot) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: null,
    maxBuffer: 20_000_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Could not enumerate tracked files:\n${result.stderr?.toString("utf8") ?? ""}`,
    );
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function requiresSamHeader(path) {
  if (copiedThirdPartyFixtures.has(path)) return false;
  if (
    path === ".gitignore" ||
    path === "scripts/sync-compatibility" ||
    path === "scripts/validate" ||
    path === "scripts/validate-conformance"
  ) {
    return true;
  }
  return headerExtensions.has(extname(path));
}

function readPolicyFile(
  root,
  path,
  { encoding, allowConsumedChangeset = false } = {},
) {
  try {
    return readFileSync(resolve(root, path), encoding);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      error.code === "ENOENT"
    ) {
      if (allowConsumedChangeset && consumedPendingChangesetPath.test(path)) {
        return null;
      }
      throw new Error(
        `License policy cannot inspect ${path}: file is missing from the working tree.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function readJson(root, path) {
  return JSON.parse(readPolicyFile(root, path, { encoding: "utf8" }));
}

function checkLockPolicy(root, { path, owned }) {
  const lock = readJson(root, path);
  const packages = lock.packages;
  if (
    packages === null ||
    typeof packages !== "object" ||
    Array.isArray(packages)
  ) {
    throw new Error(`${path} is missing package records.`);
  }
  for (const key of owned) {
    const entry = packages[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `${path} is missing owned package record ${JSON.stringify(key)}.`,
      );
    }
    assertManifestLicense(
      entry,
      `${path} package record ${JSON.stringify(key)}`,
    );
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (owned.includes(key) || !entry?.name?.startsWith("@meta-sam/")) continue;
    if (entry.link !== true || entry.license !== undefined) {
      throw new Error(`${path} has unexpected first-party metadata in ${key}.`);
    }
  }
}

function checkPythonMetadata(root) {
  const pyproject = readPolicyFile(root, "python/pyproject.toml", {
    encoding: "utf8",
  });
  if (!pyproject.includes('license = {file = "LICENSE"}')) {
    throw new Error(
      "python/pyproject.toml must use file-based license metadata.",
    );
  }
  if (!pyproject.includes('license-files = ["LICENSE"]')) {
    throw new Error("python/pyproject.toml must include exactly LICENSE.");
  }
  if (/License :: OSI Approved ::/i.test(pyproject)) {
    throw new Error("python/pyproject.toml must not claim OSI approval.");
  }
}

function checkLicensePolicy(root = repositoryRoot) {
  const canonicalLicense = readPolicyFile(root, licensePaths[0]);
  assertLicenseBytes(canonicalLicense, licensePaths[0]);
  for (const path of licensePaths.slice(1)) {
    const copy = readPolicyFile(root, path);
    if (!copy.equals(canonicalLicense)) {
      throw new Error(`${path} differs from the root LICENSE.`);
    }
  }

  for (const path of manifestPaths) {
    assertManifestLicense(readJson(root, path), path);
  }
  for (const policy of lockPolicies) checkLockPolicy(root, policy);
  checkPythonMetadata(root);

  let headerCount = 0;
  for (const path of trackedFiles(root)) {
    const content = readPolicyFile(root, path, {
      allowConsumedChangeset: true,
    });
    if (content === null) continue;
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    if (
      !lockPaths.has(path) &&
      !copiedThirdPartyFixtures.has(path) &&
      !thirdPartyNoticeFiles.has(path) &&
      findStaleLicenseDeclaration(text)
    ) {
      throw new Error(`${path} contains a stale legacy license declaration.`);
    }
    if (requiresSamHeader(path)) {
      const preamble = text.slice(0, 1024);
      if (!preamble.includes(SAM_HEADER)) {
        throw new Error(
          `${path} is missing the first-party SAM copyright header.`,
        );
      }
      headerCount += 1;
    }
  }

  process.stdout.write(
    `SAM license policy: ${licensePaths.length} exact copies, ${manifestPaths.length} manifests, ` +
      `${lockPolicies.reduce((count, policy) => count + policy.owned.length, 0)} owned lock records, ` +
      `${headerCount} headers; sha256=${EXPECTED_LICENSE_SHA256}.\n`,
  );
}

module.exports = {
  EXPECTED_LICENSE_SHA256,
  PACKAGE_LICENSE,
  SAM_HEADER,
  assertLicenseBytes,
  assertManifestLicense,
  checkLicensePolicy,
  findStaleLicenseDeclaration,
};

if (require.main === module) {
  try {
    checkLicensePolicy();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
