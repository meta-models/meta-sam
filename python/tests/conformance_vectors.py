# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import json
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any, Literal, cast

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from meta_sam_parser import SegmentationMaskEncoding

_CASES = Path(__file__).resolve().parents[2] / "conformance" / "cases"
_SCHEMA_PATH = _CASES.parent / "case.schema.json"
_SCHEMA = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
Draft202012Validator.check_schema(_SCHEMA)
_VALIDATOR = Draft202012Validator(_SCHEMA)


@dataclass(frozen=True, slots=True)
class SharedConformanceCase:
    name: str
    media: Literal["image", "video"]
    chunks: tuple[str, ...]
    events: tuple[dict[str, Any], ...]
    source: dict[str, Any] | None
    expected: dict[str, Any]


@dataclass(frozen=True, slots=True)
class SharedRLEObject:
    size: tuple[int, int]
    counts: str


@dataclass(frozen=True, slots=True)
class SharedMaskVector:
    case_name: str
    index: int
    encoding: SegmentationMaskEncoding
    payload: str
    width: int
    height: int
    decoded: bytes
    raster: bytes
    coco_rle: SharedRLEObject
    svg_path: str

    @property
    def test_id(self) -> str:
        return f"{self.case_name}-{self.encoding}-{self.index}"


def _semantic_failure(path: Path, message: str) -> None:
    raise AssertionError(f"Shared case {path} is invalid: {message}")


def _assert_semantic_contract(case: SharedConformanceCase, path: Path) -> None:
    terminal_types = {
        "response_completed",
        "response_incomplete",
        "response_failed",
        "error",
        "refusal_delta",
        "refusal_done",
    }
    terminal_index = next(
        (
            index
            for index, event in enumerate(case.events)
            if event["type"] in terminal_types
        ),
        -1,
    )
    if terminal_index >= 0 and terminal_index != len(case.events) - 1:
        _semantic_failure(path, "a terminal source event must be the final event")

    if case.source is not None:
        operation = case.source["operation"]
        expected_operation = "return" if operation == "close" else operation
        error = case.expected.get("error")
        if (
            not isinstance(error, dict)
            or error.get("code") != "source_error"
            or error.get("source_operation") != expected_operation
        ):
            _semantic_failure(
                path,
                f"source {operation} failure must expect source operation "
                f"{expected_operation}",
            )
        if operation == "next" and case.source["after_events"] > len(case.events):
            _semantic_failure(
                path, "source next failure cannot follow unavailable events"
            )

    snapshots = cast(list[dict[str, Any]], case.expected["snapshots"])
    result = case.expected.get("result")
    views = [*snapshots, *([cast(dict[str, Any], result)] if result else [])]
    prior_revision = -1
    for view_index, view in enumerate(views):
        if view["media"] != case.media:
            _semantic_failure(
                path, f"expected view {view_index} uses media {view['media']}"
            )
        if view_index < len(snapshots):
            revision = cast(int, view["revision"])
            if revision <= prior_revision:
                _semantic_failure(
                    path, "snapshot revisions must be strictly increasing"
                )
            prior_revision = revision
        records = cast(list[dict[str, Any]], view["records"])
        for record_index, record in enumerate(records):
            if record["order"] != record_index:
                _semantic_failure(
                    path, f"view {view_index} record orders must be contiguous"
                )
            if record["kind"] != "mask":
                continue
            mask = cast(dict[str, Any], record["mask"])
            decoded = cast(dict[str, Any], mask["decoded"])
            runs = cast(list[dict[str, int]], decoded["runs"])
            decoded_length = sum(run["length"] for run in runs)
            if (
                decoded["length"] != mask["width"] * mask["height"]
                or decoded_length != decoded["length"]
            ):
                _semantic_failure(
                    path,
                    f"view {view_index} mask {record_index} has inconsistent "
                    "decoded length",
                )
            if any(
                prior["value"] == current["value"] for prior, current in pairwise(runs)
            ):
                _semantic_failure(
                    path,
                    f"view {view_index} mask {record_index} has adjacent equal runs",
                )
            raster = cast(list[int], mask["raster"])
            if len(raster) != mask["width"] * mask["height"]:
                _semantic_failure(
                    path,
                    f"view {view_index} mask {record_index} has inconsistent "
                    "raster length",
                )
            expanded = bytes(
                value for run in runs for value in [run["value"]] * run["length"]
            )
            if bytes(raster) != expanded:
                _semantic_failure(
                    path,
                    f"view {view_index} mask {record_index} raster differs from "
                    "decoded runs",
                )
            coco_rle = cast(dict[str, Any], mask["coco_rle"])
            if coco_rle["size"] != [mask["height"], mask["width"]]:
                _semantic_failure(
                    path,
                    f"view {view_index} mask {record_index} has inconsistent COCO size",
                )
            identity = cast(dict[str, Any], record["identity"])
            if identity != {
                "media": view["media"],
                "frame_index": record["frame_index"],
                "object_id": record["object_id"],
            }:
                _semantic_failure(
                    path,
                    f"view {view_index} mask {record_index} has inconsistent identity",
                )


def _load_case(path: Path) -> SharedConformanceCase:
    value = cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))
    issues = sorted(
        _VALIDATOR.iter_errors(value),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    if issues:
        detail = "; ".join(
            f"/{'/'.join(str(part) for part in error.absolute_path)} {error.message}"
            for error in issues[:8]
        )
        raise AssertionError(f"Shared case {path} failed schema validation: {detail}")
    name = cast(str, value["name"])
    if path.name != f"{name}.json":
        raise AssertionError(f"Shared case {path} must be named {name}.json")
    case = SharedConformanceCase(
        name=name,
        media=cast(Literal["image", "video"], value["media"]),
        chunks=tuple(cast(list[str], value["chunks"])),
        events=tuple(cast(list[dict[str, Any]], value["events"])),
        source=cast(dict[str, Any] | None, value.get("source")),
        expected=cast(dict[str, Any], value["expected"]),
    )
    referenced_chunks = [
        cast(int, event["chunk"])
        for event in case.events
        if event["type"] == "output_text_delta"
    ]
    if referenced_chunks != list(range(len(case.chunks))):
        raise AssertionError(
            f"Shared case {path} must reference every chunk exactly once in order"
        )
    _assert_semantic_contract(case, path)
    return case


def load_shared_conformance_cases() -> tuple[SharedConformanceCase, ...]:
    unsupported = sorted(
        path.name
        for path in _CASES.iterdir()
        if not path.is_file() or path.suffix != ".json"
    )
    if unsupported:
        raise AssertionError(
            "Shared conformance directory has unsupported entries: "
            + ", ".join(unsupported)
        )
    cases = tuple(_load_case(path) for path in sorted(_CASES.glob("*.json")))
    if not cases:
        raise AssertionError(f"No shared conformance cases found under {_CASES}")
    names = {case.name for case in cases}
    if len(names) != len(cases):
        raise AssertionError("Shared conformance case names must be unique")
    return cases


def _expand_runs(decoded: dict[str, Any]) -> bytes:
    runs = cast(list[dict[str, int]], decoded["runs"])
    output = bytes(value for run in runs for value in [run["value"]] * run["length"])
    assert len(output) == decoded["length"]
    return output


def load_shared_mask_vectors() -> tuple[SharedMaskVector, ...]:
    vectors: list[SharedMaskVector] = []
    for case in load_shared_conformance_cases():
        result = case.expected.get("result")
        if not isinstance(result, dict):
            continue
        records = cast(list[dict[str, Any]], result["records"])
        for index, record in enumerate(records):
            if record["kind"] != "mask":
                continue
            mask = cast(dict[str, Any], record["mask"])
            coco_rle = cast(dict[str, Any], mask["coco_rle"])
            coco_size = cast(list[int], coco_rle["size"])
            vectors.append(
                SharedMaskVector(
                    case_name=case.name,
                    index=index,
                    encoding=cast(SegmentationMaskEncoding, mask["encoding"]),
                    payload=cast(str, mask["payload"]),
                    width=cast(int, mask["width"]),
                    height=cast(int, mask["height"]),
                    decoded=_expand_runs(cast(dict[str, Any], mask["decoded"])),
                    raster=bytes(cast(list[int], mask["raster"])),
                    coco_rle=SharedRLEObject(
                        size=(coco_size[0], coco_size[1]),
                        counts=cast(str, coco_rle["counts"]),
                    ),
                    svg_path=cast(str, mask["svg_path"]),
                )
            )
    if not vectors:
        raise AssertionError(f"No shared mask vectors found under {_CASES}")
    return tuple(vectors)
