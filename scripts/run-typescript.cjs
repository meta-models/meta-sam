"use strict";

/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const { runProcess } = require("./run-process.cjs");

function npmExecutable(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function runTypeScriptNpmScript(
  script,
  {
    repositoryRoot = resolve(__dirname, ".."),
    platform = process.platform,
    processLike = process,
    spawnImpl = spawn,
  } = {},
) {
  const child = spawnImpl(npmExecutable(platform), ["run", script], {
    cwd: resolve(repositoryRoot, "typescript"),
    shell: platform === "win32",
    stdio: "inherit",
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(
    signals.map((signal) => [
      signal,
      () => {
        if (!child.killed) child.kill(signal);
      },
    ]),
  );
  for (const [signal, handler] of handlers) processLike.on(signal, handler);

  let settled = false;
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) {
      processLike.removeListener(signal, handler);
    }
  };
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    removeHandlers();
    processLike.stderr.write(
      `Could not start TypeScript validation: ${error.message}\n`,
    );
    processLike.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    removeHandlers();
    if (signal !== null) processLike.kill(processLike.pid, signal);
    else processLike.exitCode = code ?? 1;
  });
  return child;
}

function runTypeScriptNpmScriptAndWait(
  script,
  {
    repositoryRoot = resolve(__dirname, ".."),
    platform = process.platform,
    processLike = process,
    spawnImpl,
  } = {},
) {
  return runProcess(npmExecutable(platform), ["run", script], {
    cwd: resolve(repositoryRoot, "typescript"),
    label: "TypeScript validation",
    platform,
    processLike,
    ...(spawnImpl === undefined ? {} : { spawnImpl }),
  });
}

module.exports = {
  npmExecutable,
  runTypeScriptNpmScript,
  runTypeScriptNpmScriptAndWait,
};
