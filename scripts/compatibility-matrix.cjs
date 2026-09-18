/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */
"use strict";

const { createHash } = require("node:crypto");
const { readFile, readdir, writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");

const MATRIX_PATH = "conformance/compatibility.json";
const PROTOCOL_PATH = "protocol/sam3.md";
const SCHEMA_PATH = "conformance/case.schema.json";
const CORPUS_PATH = "conformance/cases";
const CORPUS_DIGEST_ALGORITHM =
  "sha256 over each sorted UTF-8 filename, NUL, raw file bytes, NUL";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function corpusIdentity(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const unsupported = entries.filter(
    (entry) => !entry.isFile() || !entry.name.endsWith(".json"),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `unsupported conformance entries: ${unsupported.map((entry) => entry.name).join(", ")}`,
    );
  }
  const files = entries.map((entry) => entry.name).sort();
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(await readFile(resolve(directory, file)));
    digest.update(Buffer.from([0]));
  }
  return { count: files.length, sha256: digest.digest("hex") };
}

function contractIdentity(protocolSha256, schemaSha256, corpusSha256) {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(protocolSha256, "hex"))
    .update(Buffer.from(schemaSha256, "hex"))
    .update(Buffer.from(corpusSha256, "hex"))
    .digest("hex")}`;
}

function pythonIdentity(pyproject) {
  const name = pyproject.match(/^name = "([^"]+)"$/m)?.[1];
  const version = pyproject.match(/^version = "([^"]+)"$/m)?.[1];
  if (!name || !version) {
    throw new Error("python/pyproject.toml must define project name and version");
  }
  return { name, version };
}

/**
 * Computes the compatibility matrix from the checked-in protocol document,
 * case schema, conformance corpus, and both implementation manifests. The
 * result is the only content `compatibility.json` may hold.
 */
async function computeCompatibilityMatrix(repositoryRoot) {
  const protocolBytes = await readFile(resolve(repositoryRoot, PROTOCOL_PATH));
  const schemaBytes = await readFile(resolve(repositoryRoot, SCHEMA_PATH));
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const schemaVersion = schema.properties?.schema_version?.const;
  if (!Number.isInteger(schemaVersion)) {
    throw new Error("the case schema must pin an integer schema_version");
  }
  const corpus = await corpusIdentity(resolve(repositoryRoot, CORPUS_PATH));
  const protocolSha256 = sha256(protocolBytes);
  const schemaSha256 = sha256(schemaBytes);
  const identity = contractIdentity(
    protocolSha256,
    schemaSha256,
    corpus.sha256,
  );

  const parserManifest = await readJson(
    resolve(repositoryRoot, "typescript/packages/parser/package.json"),
  );
  const python = pythonIdentity(
    await readFile(resolve(repositoryRoot, "python/pyproject.toml"), "utf8"),
  );

  return {
    contract: {
      protocol: {
        path: PROTOCOL_PATH,
        version_status: "unversioned",
        sha256: protocolSha256,
      },
      schema: {
        path: SCHEMA_PATH,
        schema_version: schemaVersion,
        sha256: schemaSha256,
      },
      corpus: {
        path: CORPUS_PATH,
        case_count: corpus.count,
        digest_algorithm: CORPUS_DIGEST_ALGORITHM,
        sha256: corpus.sha256,
      },
      identity,
    },
    implementations: [
      {
        language: "typescript",
        distribution: parserManifest.name,
        version: parserManifest.version,
        contract_identity: identity,
      },
      {
        language: "python",
        distribution: python.name,
        version: python.version,
        contract_identity: identity,
      },
    ],
  };
}

function serializeMatrix(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

async function writeCompatibilityMatrix(repositoryRoot) {
  const matrix = await computeCompatibilityMatrix(repositoryRoot);
  await writeFile(resolve(repositoryRoot, MATRIX_PATH), serializeMatrix(matrix));
  return matrix;
}

module.exports = {
  MATRIX_PATH,
  computeCompatibilityMatrix,
  corpusIdentity,
  serializeMatrix,
  sha256,
  writeCompatibilityMatrix,
};
