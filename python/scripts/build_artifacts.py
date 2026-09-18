# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_REPRODUCIBLE_EPOCH = "1580601600"


def _project_identity(project_root: Path) -> tuple[str, str]:
    content = (project_root / "pyproject.toml").read_text(encoding="utf-8")
    try:
        project = content.split("[project]", 1)[1].split("\n[", 1)[0]
    except IndexError as error:
        raise ValueError("pyproject.toml is missing [project] metadata") from error
    name = re.search(r'^name = "([^"]+)"$', project, re.MULTILINE)
    version = re.search(r'^version = "([^"]+)"$', project, re.MULTILINE)
    if name is None or version is None:
        raise ValueError("pyproject.toml must define project name and version")
    return name.group(1), version.group(1)


def _artifact_names(project_root: Path) -> set[str]:
    distribution, version = _project_identity(project_root)
    package = distribution.replace("-", "_")
    return {
        f"{package}-{version}-py3-none-any.whl",
        f"{package}-{version}.tar.gz",
    }


def _prepare_output(project_root: Path, requested: Path) -> Path:
    candidate = requested if requested.is_absolute() else project_root / requested
    candidate = candidate.absolute()
    if candidate.is_symlink():
        raise ValueError(f"artifact output cannot be a symlink: {candidate}")
    output = candidate.resolve()
    project_root = project_root.resolve()
    if project_root.is_relative_to(output):
        raise ValueError(f"artifact output cannot contain the project: {output}")
    if output.is_relative_to(project_root) and output != project_root / "dist":
        raise ValueError(f"artifact output inside the project must be dist/: {output}")
    if output.exists():
        if not output.is_dir():
            raise ValueError(f"artifact output is not a directory: {output}")
        entries = list(output.iterdir())
        artifact_names = _artifact_names(project_root)
        unsafe = [
            entry.name
            for entry in entries
            if entry.is_symlink()
            or not entry.is_file()
            or entry.name not in artifact_names
        ]
        if unsafe:
            raise ValueError(
                f"refusing to clear unexpected artifact output entries: {unsafe}"
            )
        for entry in entries:
            entry.unlink()
    else:
        output.mkdir(parents=True)
    return output


def _check_source_inputs(project_root: Path) -> None:
    for name in ("LICENSE", "README.md", "pyproject.toml"):
        path = project_root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"package input must be a regular file: {path}")
    source_root = project_root / "src"
    if source_root.is_symlink() or not source_root.is_dir():
        raise ValueError(f"package source must be a regular directory: {source_root}")
    for root, directories, files in os.walk(source_root, followlinks=False):
        for name in directories:
            path = Path(root) / name
            if path.is_symlink() or not path.is_dir():
                raise ValueError(f"package source directory is unsafe: {path}")
        for name in files:
            path = Path(root) / name
            if path.is_symlink() or not path.is_file():
                raise ValueError(f"package source file is unsafe: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build registry-neutral Python release artifacts."
    )
    parser.add_argument(
        "--outdir",
        type=Path,
        default=Path("dist"),
        help="artifact output directory, relative to python/ by default",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    output = _prepare_output(project_root, args.outdir)
    _check_source_inputs(project_root)
    environment = os.environ.copy()
    environment["SOURCE_DATE_EPOCH"] = _REPRODUCIBLE_EPOCH
    with tempfile.TemporaryDirectory(prefix="meta-sam-python-build-") as temporary:
        source = Path(temporary) / "source"
        source.mkdir()
        for name in ("LICENSE", "README.md", "pyproject.toml"):
            shutil.copy2(project_root / name, source / name)
        shutil.copytree(
            project_root / "src",
            source / "src",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "build",
                "--no-isolation",
                "--wheel",
                "--sdist",
                "--outdir",
                str(output),
                str(source),
            ],
            check=True,
            cwd=source,
            env=environment,
        )


if __name__ == "__main__":
    main()
