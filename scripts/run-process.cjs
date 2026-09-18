/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */
"use strict";

const { spawn } = require("node:child_process");

function runProcess(
  command,
  args,
  {
    cwd,
    label,
    platform = process.platform,
    processLike = process,
    spawnImpl = spawn,
  },
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        shell: platform === "win32",
        stdio: "inherit",
      });
    } catch (error) {
      processLike.stderr.write(`Could not start ${label}: ${error.message}\n`);
      resolve(1);
      return;
    }

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
    const settle = (code) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) {
        processLike.removeListener(signal, handler);
      }
      resolve(code);
    };
    child.once("error", (error) => {
      processLike.stderr.write(`Could not start ${label}: ${error.message}\n`);
      settle(1);
    });
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        processLike.kill(processLike.pid, signal);
        settle(1);
      } else {
        settle(code ?? 1);
      }
    });
  });
}

module.exports = { runProcess };
