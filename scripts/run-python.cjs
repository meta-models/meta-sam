"use strict";

/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

const { resolve } = require("node:path");

const { runProcess } = require("./run-process.cjs");

function pythonExecutable(
  platform = process.platform,
  environment = process.env,
) {
  return environment.PYTHON ?? (platform === "win32" ? "python" : "python3");
}

async function runPythonCommands(
  commands,
  {
    repositoryRoot = resolve(__dirname, ".."),
    platform = process.platform,
    processLike = process,
    spawnImpl,
  } = {},
) {
  const executable = pythonExecutable(platform, processLike.env);
  for (const args of commands) {
    const code = await runProcess(executable, args, {
      cwd: resolve(repositoryRoot, "python"),
      label: "Python validation",
      platform,
      processLike,
      ...(spawnImpl === undefined ? {} : { spawnImpl }),
    });
    if (code !== 0) return code;
  }
  return 0;
}

module.exports = { pythonExecutable, runPythonCommands };
