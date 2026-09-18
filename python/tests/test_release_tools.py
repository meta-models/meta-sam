# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import Any, cast

import pytest

_PYTHON_ROOT = Path(__file__).resolve().parents[1]
_BUILD = _PYTHON_ROOT / "scripts" / "build_artifacts.py"
_AUDIT = _PYTHON_ROOT / "scripts" / "audit_distribution.py"


def _load_audit_module() -> Any:
    spec = importlib.util.spec_from_file_location("meta_sam_audit_test", _AUDIT)
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load audit_distribution.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return cast(Any, module)


def _run(script: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *arguments],
        cwd=_PYTHON_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def test_builder_refuses_to_clear_the_project() -> None:
    pyproject = _PYTHON_ROOT / "pyproject.toml"
    before = pyproject.read_bytes()
    result = _run(_BUILD, "--outdir", ".")
    assert result.returncode != 0
    assert "cannot contain the project" in result.stderr
    assert pyproject.read_bytes() == before


def test_builder_preserves_unexpected_output_entries(tmp_path: Path) -> None:
    output = tmp_path / "artifacts"
    output.mkdir()
    sentinel = output / "keep.txt"
    sentinel.write_text("keep")
    result = _run(_BUILD, "--outdir", str(output))
    assert result.returncode != 0
    assert "refusing to clear" in result.stderr
    assert sentinel.read_text() == "keep"


def test_packaged_readme_uses_a_distribution_safe_protocol_link() -> None:
    readme = (_PYTHON_ROOT / "README.md").read_text(encoding="utf-8")
    assert "](../" not in readme
    assert (
        "https://github.com/meta-models/meta-sam/blob/main/protocol/sam3.md" in readme
    )


def test_pyproject_uses_file_based_sam_license_metadata() -> None:
    pyproject = (_PYTHON_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'license = {file = "LICENSE"}' in pyproject
    assert 'license-files = ["LICENSE"]' in pyproject
    assert "License :: OSI Approved ::" not in pyproject
    assert ("M" + "IT") not in pyproject


def test_source_byte_reads_reject_symlinked_inputs(tmp_path: Path) -> None:
    audit = _load_audit_module()
    root = tmp_path / "project"
    root.mkdir()
    target = tmp_path / "outside-readme"
    target.write_bytes(b"outside")
    readme = root / "README.md"
    readme.symlink_to(target)
    audit._PROJECT_ROOT = root

    with pytest.raises(audit.AuditError, match="cannot be a symlink"):
        audit._source_bytes(readme)


@pytest.mark.parametrize(
    "content,label",
    [
        (b"https://internalfb.com/example", "internal hostname"),
        (b"/home/example/source.py", "absolute home path"),
        (b"authorization: bearer synthetic-token", "bearer credential"),
    ],
)
def test_forbidden_content_scan_covers_hosts_paths_and_credentials(
    content: bytes, label: str
) -> None:
    audit = _load_audit_module()
    with pytest.raises(audit.AuditError, match=label):
        audit._check_content("member", content)


def test_audit_rejects_artifact_symlinks(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.write_bytes(b"not a wheel")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "meta_sam_parser-0.0.2-py3-none-any.whl").symlink_to(target)
    (dist / "meta_sam_parser-0.0.2.tar.gz").write_bytes(b"not an sdist")
    result = _run(_AUDIT, "--mode", "artifacts", "--dist-dir", str(dist))
    assert result.returncode != 0
    assert "unsafe entries" in result.stderr
    assert target.read_bytes() == b"not a wheel"
