# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import argparse
import ast
import base64
import csv
import hashlib
import io
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tarfile
import tempfile
import venv
import zipfile
from dataclasses import dataclass
from email.message import Message
from email.parser import BytesParser
from email.policy import default
from pathlib import Path, PurePosixPath

_PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _project_identity(project_root: Path) -> tuple[str, str]:
    content = (project_root / "pyproject.toml").read_text(encoding="utf-8")
    try:
        project = content.split("[project]", 1)[1].split("\n[", 1)[0]
    except IndexError as error:
        raise RuntimeError("pyproject.toml is missing [project] metadata") from error
    name = re.search(r'^name = "([^"]+)"$', project, re.MULTILINE)
    version = re.search(r'^version = "([^"]+)"$', project, re.MULTILINE)
    if name is None or version is None:
        raise RuntimeError("pyproject.toml must define project name and version")
    return name.group(1), version.group(1)


_DISTRIBUTION, _VERSION = _project_identity(_PROJECT_ROOT)
_PACKAGE = _DISTRIBUTION.replace("-", "_")
_BUILD_REQUIREMENT = "hatchling==1.27.0"
_WHEEL_NAME = f"{_PACKAGE}-{_VERSION}-py3-none-any.whl"
_SDIST_NAME = f"{_PACKAGE}-{_VERSION}.tar.gz"
_SDIST_ROOT = f"{_PACKAGE}-{_VERSION}"
_SOURCE_FILES = (
    "__init__.py",
    "_errors.py",
    "_mask_codec.py",
    "_mask_conversion.py",
    "_segmentation.py",
    "_stream.py",
    "_types.py",
    "py.typed",
)
_EXPECTED_EXPORTS = (
    "CompletedOutcome",
    "DiagnosticSeverity",
    "FrameReference",
    "ImageSegmentationResult",
    "ImageSegmentationSnapshot",
    "IncompleteOutcome",
    "IncompleteReason",
    "InvalidSegmentationMaskError",
    "OutputTextLane",
    "ParsedResponsesStream",
    "ParserFinish",
    "RLEObject",
    "ResponseFormat",
    "ResponseFormatParser",
    "ResponseSourceOperation",
    "ResponseStreamOutcome",
    "ResponsesEvent",
    "ResponsesEventLike",
    "ResponsesStreamAbortedError",
    "ResponsesStreamConsumedError",
    "ResponsesStreamError",
    "ResponsesStreamEventError",
    "ResponsesStreamFailedError",
    "ResponsesStreamLaneError",
    "ResponsesStreamParserError",
    "ResponsesStreamRefusalError",
    "ResponsesStreamSourceError",
    "SegmentationBoxRecord",
    "SegmentationDiagnostic",
    "SegmentationMask",
    "SegmentationMaskBounds",
    "SegmentationMaskEncoding",
    "SegmentationMaskIdentity",
    "SegmentationMaskRecord",
    "SegmentationMedia",
    "SegmentationRecord",
    "SegmentationResult",
    "SegmentationSnapshot",
    "SegmentationTextRecord",
    "VideoSegmentationResult",
    "VideoSegmentationSnapshot",
    "decode_mask_to_raster",
    "decode_mask_to_rle",
    "decode_mask_to_svg_path",
    "image_segmentation_format",
    "parse_responses_stream",
    "video_segmentation_format",
)
_EXPECTED_DEV_REQUIREMENTS = {
    "build==1.3.0; extra == 'dev'",
    "hatchling==1.27.0; extra == 'dev'",
    "jsonschema==4.25.1; extra == 'dev'",
    "mypy==1.18.2; extra == 'dev'",
    "pytest-cov==7.0.0; extra == 'dev'",
    "pytest==9.0.3; extra == 'dev'",
    "ruff==0.13.1; extra == 'dev'",
}
_FORBIDDEN_CONTENT = (
    ("absolute home path", re.compile(rb"(?:/home/|/Users/|[A-Za-z]:\\Users\\)")),
    ("temporary path", re.compile(rb"/tmp/")),
    (
        "internal hostname",
        re.compile(
            rb"(?:internalfb\.com|internalmeta\.com|fburl\.com|corp\.facebook\.com|tfbnw\.net)",
            re.I,
        ),
    ),
    ("source map metadata", re.compile(rb"sourceMappingURL=")),
    ("private key", re.compile(rb"BEGIN [A-Z ]*PRIVATE KEY")),
    ("AWS access key", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("GitHub token", re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("OpenAI key", re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("bearer credential", re.compile(rb"authorization\s*[:=]\s*bearer\s+\S+", re.I)),
    (
        "JWT credential",
        re.compile(rb"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    ),
    (
        "credential assignment",
        re.compile(
            rb"(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*['\"][^'\"]+",
            re.I,
        ),
    ),
)
_FORBIDDEN_PARTS = {
    ".coverage",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "dist",
    "node_modules",
}


class AuditError(RuntimeError):
    pass


@dataclass(frozen=True)
class ArtifactReport:
    kind: str
    path: Path
    file_count: int
    sha256: str


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_digest(path: Path) -> str:
    return _digest(path.read_bytes())


def _check_archive_path(name: str) -> None:
    path = PurePosixPath(name)
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or path.as_posix() != name
        or ".." in path.parts
    ):
        raise AuditError(f"unsafe archive path: {name!r}")
    if any(part in _FORBIDDEN_PARTS for part in path.parts):
        raise AuditError(f"forbidden archive path: {name}")
    if path.suffix in {".map", ".pyc", ".pyo"}:
        raise AuditError(f"forbidden generated file: {name}")


def _check_content(name: str, content: bytes) -> None:
    for label, pattern in _FORBIDDEN_CONTENT:
        if pattern.search(content):
            raise AuditError(f"{name} contains {label}")


def _source_bytes(path: Path) -> bytes:
    relative = path.relative_to(_PROJECT_ROOT)
    current = _PROJECT_ROOT
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise AuditError(f"package source input cannot be a symlink: {current}")
    if not path.is_file():
        raise AuditError(f"package source input must be a regular file: {path}")
    return path.read_bytes()


def _metadata_body(message: Message) -> str:
    body = message.get_payload()
    if not isinstance(body, str):
        raise AuditError("package metadata has a multipart description")
    return body.rstrip("\n")


def _check_metadata(content: bytes, source: str) -> None:
    metadata = BytesParser(policy=default).parsebytes(content)
    expected = {
        "Name": _DISTRIBUTION,
        "Version": _VERSION,
        "Summary": (
            "Native Python parsing primitives for the SAM 3 segmentation protocol"
        ),
        "Requires-Python": ">=3.10",
        "Description-Content-Type": "text/markdown",
    }
    for field, value in expected.items():
        if metadata[field] != value:
            raise AuditError(
                f"{source} metadata {field} is {metadata[field]!r}, expected {value!r}"
            )
    license_text = _source_bytes(_PROJECT_ROOT / "LICENSE").decode("utf-8").rstrip("\n")
    normalized_metadata_license = " ".join(str(metadata["License"] or "").split())
    normalized_source_license = " ".join(license_text.split())
    if normalized_metadata_license != normalized_source_license:
        raise AuditError(f"{source} metadata License does not match python/LICENSE")
    if metadata["License-Expression"] is not None:
        raise AuditError(f"{source} must not claim an SPDX license expression")
    if metadata.get_all("License-File", []) != ["LICENSE"]:
        raise AuditError(f"{source} metadata must include exactly LICENSE")
    classifiers = set(metadata.get_all("Classifier", []))
    if "Typing :: Typed" not in classifiers:
        raise AuditError(f"{source} metadata is missing the typed classifier")
    license_classifiers = sorted(
        classifier for classifier in classifiers if classifier.startswith("License ::")
    )
    if license_classifiers:
        raise AuditError(
            f"{source} must not claim a license classifier: {license_classifiers}"
        )
    legacy_pattern = re.compile(rb"\bM" + rb"IT\b", re.IGNORECASE)
    if legacy_pattern.search(content):
        raise AuditError(f"{source} contains a stale legacy license claim")

    requirements = set(metadata.get_all("Requires-Dist", []))
    if requirements != _EXPECTED_DEV_REQUIREMENTS:
        raise AuditError(
            f"{source} dependencies differ from the audited dev-only set: "
            f"{sorted(requirements)}"
        )
    if metadata.get_all("Provides-Extra", []) != ["dev"]:
        raise AuditError(f"{source} must expose only the dev extra")

    readme = _source_bytes(_PROJECT_ROOT / "README.md").decode("utf8").rstrip("\n")
    if re.search(r"\]\((?:\.\./)+", readme):
        raise AuditError(f"{source} embedded README contains a parent-relative link")
    if _metadata_body(metadata) != readme:
        raise AuditError(f"{source} embedded README does not match python/README.md")


def _check_root_exports(content: bytes) -> None:
    module = ast.parse(content, filename="meta_sam_parser/__init__.py")
    exports: object | None = None
    for statement in module.body:
        if not isinstance(statement, ast.Assign):
            continue
        if any(
            isinstance(target, ast.Name) and target.id == "__all__"
            for target in statement.targets
        ):
            exports = ast.literal_eval(statement.value)
            break
    if not isinstance(exports, list) or not all(
        isinstance(value, str) for value in exports
    ):
        raise AuditError("package root must define a literal string __all__")
    if tuple(exports) != _EXPECTED_EXPORTS:
        raise AuditError("package root exports do not match the audited public API")

    readme = _source_bytes(_PROJECT_ROOT / "README.md").decode("utf8")
    if re.search(r"(?:from|import)\s+meta_sam_parser\.", readme):
        raise AuditError("README documents an unsupported deep import")
    if "Deep imports are unsupported" not in readme:
        raise AuditError("README must state that deep imports are unsupported")
    undocumented = [
        export for export in _EXPECTED_EXPORTS if f"`{export}`" not in readme
    ]
    if undocumented:
        raise AuditError(f"README does not document root exports: {undocumented}")


def _check_record(archive: zipfile.ZipFile, expected: set[str]) -> None:
    record_name = f"{_PACKAGE}-{_VERSION}.dist-info/RECORD"
    rows = list(
        csv.reader(io.StringIO(archive.read(record_name).decode("utf8"), newline=""))
    )
    if any(len(row) != 3 for row in rows):
        raise AuditError("wheel RECORD contains a malformed row")
    records = {row[0]: (row[1], row[2]) for row in rows}
    if len(records) != len(rows) or set(records) != expected:
        raise AuditError("wheel RECORD does not enumerate the exact wheel payload")
    for name, (encoded_hash, encoded_size) in records.items():
        if name == record_name:
            if encoded_hash or encoded_size:
                raise AuditError("wheel RECORD must not hash itself")
            continue
        content = archive.read(name)
        expected_hash = base64.urlsafe_b64encode(hashlib.sha256(content).digest())
        expected_hash = expected_hash.rstrip(b"=").decode("ascii")
        if encoded_hash != f"sha256={expected_hash}":
            raise AuditError(f"wheel RECORD hash mismatch for {name}")
        if encoded_size != str(len(content)):
            raise AuditError(f"wheel RECORD size mismatch for {name}")


def _audit_wheel(path: Path) -> ArtifactReport:
    dist_info = f"{_PACKAGE}-{_VERSION}.dist-info"
    expected = {f"{_PACKAGE}/{name}" for name in _SOURCE_FILES}
    expected.update(
        {
            f"{dist_info}/METADATA",
            f"{dist_info}/RECORD",
            f"{dist_info}/WHEEL",
            f"{dist_info}/licenses/LICENSE",
        }
    )
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            raise AuditError("wheel contains duplicate paths")
        for info in infos:
            _check_archive_path(info.filename)
            mode = info.external_attr >> 16
            if info.is_dir() or stat.S_ISLNK(mode):
                raise AuditError(f"wheel contains an unsafe entry: {info.filename}")
        if set(names) != expected:
            missing = sorted(expected - set(names))
            unexpected = sorted(set(names) - expected)
            raise AuditError(
                f"wheel allowlist mismatch; missing={missing}, unexpected={unexpected}"
            )
        for name in names:
            _check_content(name, archive.read(name))
        for source_name in _SOURCE_FILES:
            packed = archive.read(f"{_PACKAGE}/{source_name}")
            source = _source_bytes(_PROJECT_ROOT / "src" / _PACKAGE / source_name)
            if packed != source:
                raise AuditError(f"wheel source differs from checkout: {source_name}")
        if archive.read(f"{_PACKAGE}/py.typed") != b"":
            raise AuditError("py.typed must be an empty marker file")
        license_bytes = _source_bytes(_PROJECT_ROOT / "LICENSE")
        if archive.read(f"{dist_info}/licenses/LICENSE") != license_bytes:
            raise AuditError("wheel license differs from python/LICENSE")
        _check_metadata(archive.read(f"{dist_info}/METADATA"), "wheel")
        wheel_metadata = archive.read(f"{dist_info}/WHEEL").decode("utf8")
        for line in ("Root-Is-Purelib: true", "Tag: py3-none-any"):
            if line not in wheel_metadata:
                raise AuditError(f"wheel metadata is missing {line!r}")
        _check_root_exports(archive.read(f"{_PACKAGE}/__init__.py"))
        _check_record(archive, expected)
    return ArtifactReport("wheel", path, len(expected), _file_digest(path))


def _audit_sdist(path: Path) -> ArtifactReport:
    expected_relative = {
        "LICENSE",
        "PKG-INFO",
        "README.md",
        "pyproject.toml",
        *(f"src/{_PACKAGE}/{name}" for name in _SOURCE_FILES),
    }
    expected = {f"{_SDIST_ROOT}/{name}" for name in expected_relative}
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)):
            raise AuditError("sdist contains duplicate paths")
        for member in members:
            _check_archive_path(member.name)
            if not member.isfile():
                raise AuditError(f"sdist contains a non-file entry: {member.name}")
        if set(names) != expected:
            missing = sorted(expected - set(names))
            unexpected = sorted(set(names) - expected)
            raise AuditError(
                f"sdist allowlist mismatch; missing={missing}, unexpected={unexpected}"
            )
        contents: dict[str, bytes] = {}
        for member in members:
            extracted = archive.extractfile(member)
            if extracted is None:
                raise AuditError(f"could not read sdist member {member.name}")
            contents[member.name] = extracted.read()
            _check_content(member.name, contents[member.name])

        source_map = {
            "LICENSE": _PROJECT_ROOT / "LICENSE",
            "README.md": _PROJECT_ROOT / "README.md",
            "pyproject.toml": _PROJECT_ROOT / "pyproject.toml",
        }
        source_map.update(
            {
                f"src/{_PACKAGE}/{name}": _PROJECT_ROOT / "src" / _PACKAGE / name
                for name in _SOURCE_FILES
            }
        )
        for relative, source in source_map.items():
            if contents[f"{_SDIST_ROOT}/{relative}"] != _source_bytes(source):
                raise AuditError(f"sdist file differs from checkout: {relative}")
        _check_metadata(contents[f"{_SDIST_ROOT}/PKG-INFO"], "sdist")
    return ArtifactReport("sdist", path, len(expected), _file_digest(path))


def _artifact_paths(dist_dir: Path) -> tuple[Path, Path]:
    if dist_dir.is_symlink() or not dist_dir.is_dir():
        raise AuditError(f"dist must be a regular directory: {dist_dir}")
    entries = sorted(dist_dir.iterdir())
    unsafe = [path.name for path in entries if path.is_symlink() or not path.is_file()]
    if unsafe:
        raise AuditError(f"dist contains unsafe entries: {unsafe}")
    expected = {_WHEEL_NAME, _SDIST_NAME}
    actual = {path.name for path in entries}
    if actual != expected:
        raise AuditError(
            f"dist must contain exactly {sorted(expected)}; found {sorted(actual)}"
        )
    return dist_dir / _WHEEL_NAME, dist_dir / _SDIST_NAME


def audit_artifacts(dist_dir: Path) -> tuple[ArtifactReport, ArtifactReport]:
    wheel, sdist = _artifact_paths(dist_dir)
    reports = (_audit_wheel(wheel), _audit_sdist(sdist))
    for report in reports:
        print(f"{report.kind} audit: {report.file_count} files, sha256={report.sha256}")
    print(
        f"metadata audit: {_DISTRIBUTION} {_VERSION}, "
        "SAM License file metadata, typed, "
        "README embedded, 0 runtime dependencies"
    )
    print(
        f"public API audit: {len(_EXPECTED_EXPORTS)} root exports; "
        "deep imports unsupported"
    )
    return reports


def _build_once(output: Path) -> dict[str, str]:
    subprocess.run(
        [
            sys.executable,
            str(_PROJECT_ROOT / "scripts" / "build_artifacts.py"),
            "--outdir",
            str(output),
        ],
        check=True,
        cwd=_PROJECT_ROOT,
    )
    return {path.name: _file_digest(path) for path in sorted(output.iterdir())}


def check_reproducibility(dist_dir: Path) -> None:
    expected = {path.name: _file_digest(path) for path in _artifact_paths(dist_dir)}
    with tempfile.TemporaryDirectory(prefix="meta-sam-repro-") as temporary:
        root = Path(temporary)
        first = _build_once(root / "first")
        second = _build_once(root / "second")
    if first != second or first != expected:
        raise AuditError(
            f"release artifacts are not byte-reproducible: dist={expected}, "
            f"first={first}, second={second}"
        )
    print("reproducibility audit: wheel and sdist are byte-identical across 3 builds")


def _clean_environment(home: Path) -> dict[str, str]:
    home.mkdir()
    environment = {
        key: os.environ[key]
        for key in ("PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "WINDIR")
        if key in os.environ
    }
    find_links = os.environ.get("PIP_FIND_LINKS")
    if find_links:
        for value in shlex.split(find_links):
            local = Path(value.removeprefix("file://"))
            if "://" in value and not value.startswith("file://"):
                raise AuditError("PIP_FIND_LINKS must contain only local paths")
            if local.is_symlink() or not local.is_dir():
                raise AuditError(f"PIP_FIND_LINKS is not a regular directory: {value}")
        environment["PIP_FIND_LINKS"] = find_links
        environment["PIP_NO_INDEX"] = "1"
    environment.update(
        {
            "HOME": str(home),
            "NETRC": os.devnull,
            "PIP_CONFIG_FILE": os.devnull,
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_KEYRING_PROVIDER": "disabled",
            "PIP_NO_CACHE_DIR": "1",
            "PIP_NO_INPUT": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "XDG_CONFIG_HOME": str(home / ".config"),
        }
    )
    return environment


def _venv_python(root: Path) -> Path:
    executable = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not executable.is_file():
        raise AuditError(f"virtual environment did not create {executable}")
    return executable


def _run(command: list[str], *, cwd: Path, environment: dict[str, str]) -> None:
    subprocess.run(command, check=True, cwd=cwd, env=environment)


def _install_artifact(
    python: Path, artifact: Path, *, environment: dict[str, str]
) -> None:
    arguments = [
        str(python),
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-compile",
        "--no-deps",
    ]
    is_sdist = artifact.name.endswith(".tar.gz")
    if is_sdist:
        _run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-compile",
                _BUILD_REQUIREMENT,
            ],
            cwd=artifact.parent,
            environment=environment,
        )
        arguments.append("--no-build-isolation")
    arguments.append(str(artifact))
    _run(arguments, cwd=artifact.parent, environment=environment)
    if is_sdist:
        _run(
            [
                str(python),
                "-m",
                "pip",
                "uninstall",
                "--yes",
                "hatchling",
                "packaging",
                "pathspec",
                "pluggy",
                "trove-classifiers",
                "tomli",
            ],
            cwd=artifact.parent,
            environment=environment,
        )


def _check_clean_environment(
    python: Path, *, cwd: Path, environment: dict[str, str]
) -> None:
    _run(
        [str(python), "-m", "pip", "check"],
        cwd=cwd,
        environment=environment,
    )
    completed = subprocess.run(
        [str(python), "-m", "pip", "list", "--format=json"],
        check=True,
        cwd=cwd,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
    )
    installed = {entry["name"].lower() for entry in json.loads(completed.stdout)}
    unexpected = installed - {_DISTRIBUTION, "pip", "setuptools"}
    if unexpected:
        raise AuditError(
            f"clean consumer has unexpected packages: {sorted(unexpected)}"
        )


def _run_typecheck(
    python: Path,
    *,
    cwd: Path,
    environment: dict[str, str],
    source: Path | None = None,
) -> None:
    if source is None:
        source = _PROJECT_ROOT / "consumer" / "typecheck.py"
    _run(
        [
            sys.executable,
            "-m",
            "mypy",
            "--strict",
            "--no-incremental",
            "--cache-dir",
            str(cwd / ".mypy-cache"),
            "--python-executable",
            str(python),
            str(source),
        ],
        cwd=cwd,
        environment=environment,
    )


def _check_openai_requirement() -> str:
    requirements = (_PROJECT_ROOT / "requirements-openai.txt").read_text().splitlines()
    if requirements != ["openai==2.26.0"]:
        raise AuditError("OpenAI consumer requirement must remain pinned to 2.26.0")
    return requirements[0]


def _audit_consumer(artifact: Path, *, openai: bool) -> None:
    with tempfile.TemporaryDirectory(
        prefix=f"meta-sam-{artifact.suffix}-consumer-"
    ) as temporary:
        root = Path(temporary)
        environment = _clean_environment(root / "home")
        venv.EnvBuilder(with_pip=True, clear=True).create(root / "venv")
        python = _venv_python(root / "venv")
        _install_artifact(python, artifact, environment=environment)
        _check_clean_environment(python, cwd=root, environment=environment)

        runtime_environment = environment.copy()
        runtime_environment["META_SAM_SOURCE_ROOT"] = str(
            (_PROJECT_ROOT / "src").resolve()
        )
        _run(
            [
                str(python),
                "-I",
                str(_PROJECT_ROOT / "consumer" / "runtime_smoke.py"),
            ],
            cwd=root,
            environment=runtime_environment,
        )
        _run_typecheck(python, cwd=root, environment=environment)
        print(f"{artifact.name}: clean install, pip check, runtime, and typing passed")

        if openai:
            requirement = _check_openai_requirement()
            _run(
                [
                    str(python),
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--no-compile",
                    "--requirement",
                    str(_PROJECT_ROOT / "requirements-openai.txt"),
                ],
                cwd=root,
                environment=environment,
            )
            _run(
                [str(python), "-m", "pip", "check"],
                cwd=root,
                environment=environment,
            )
            _run(
                [
                    str(python),
                    "-I",
                    str(_PROJECT_ROOT / "consumer" / "openai_smoke.py"),
                ],
                cwd=root,
                environment=runtime_environment,
            )
            _run_typecheck(
                python,
                cwd=root,
                environment=environment,
                source=_PROJECT_ROOT / "consumer" / "openai_typecheck.py",
            )
            print(f"official SDK smoke and typing: {requirement} passed")


def audit_consumers(dist_dir: Path) -> None:
    wheel, sdist = _artifact_paths(dist_dir)
    _audit_consumer(wheel, openai=True)
    _audit_consumer(sdist, openai=False)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audit built Python release artifacts and clean consumers."
    )
    parser.add_argument(
        "--dist-dir",
        type=Path,
        default=Path("dist"),
        help="directory containing exactly one wheel and one sdist",
    )
    parser.add_argument(
        "--mode",
        choices=("all", "artifacts", "consumers"),
        default="all",
    )
    args = parser.parse_args()
    requested = args.dist_dir
    if not requested.is_absolute():
        requested = _PROJECT_ROOT / requested
    requested = requested.absolute()
    if requested.is_symlink():
        raise AuditError(f"dist cannot be a symlink: {requested}")
    dist_dir = requested.resolve()

    if args.mode in {"all", "artifacts"}:
        audit_artifacts(dist_dir)
        check_reproducibility(dist_dir)
    if args.mode in {"all", "consumers"}:
        if args.mode == "consumers":
            audit_artifacts(dist_dir)
        audit_consumers(dist_dir)


if __name__ == "__main__":
    try:
        main()
    except (AuditError, OSError, subprocess.CalledProcessError) as error:
        print(f"package audit failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
