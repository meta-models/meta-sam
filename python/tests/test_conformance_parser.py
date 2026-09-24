# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterable, AsyncIterator
from pathlib import Path
from typing import Any, cast

import pytest
from conformance_vectors import (
    SharedConformanceCase,
    _load_case,
    load_shared_conformance_cases,
)

from meta_sam_parser import (
    IncompleteOutcome,
    OutputTextLane,
    ResponseFormat,
    ResponsesStreamError,
    ResponsesStreamLaneError,
    ResponsesStreamSourceError,
    SegmentationBoxRecord,
    SegmentationMaskRecord,
    SegmentationRecord,
    SegmentationResult,
    SegmentationSnapshot,
    SegmentationTextRecord,
    decode_mask_to_raster,
    decode_mask_to_rle,
    decode_mask_to_svg_path,
    image_segmentation_format,
    parse_responses_stream,
    video_segmentation_format,
)

_CASES = load_shared_conformance_cases()


def _decoded_mask(value: bytes) -> dict[str, Any]:
    runs: list[dict[str, int]] = []
    for byte in value:
        if runs and runs[-1]["value"] == byte:
            runs[-1]["length"] += 1
        else:
            runs.append({"value": byte, "length": 1})
    return {"length": len(value), "runs": runs}


def _with_confidence(
    normalized: dict[str, Any], confidence: float | None
) -> dict[str, Any]:
    if confidence is not None:
        normalized["confidence"] = confidence
    return normalized


def _normalize_record(record: SegmentationRecord) -> dict[str, Any]:
    if isinstance(record, SegmentationTextRecord):
        return {"kind": record.kind, "order": record.order, "text": record.text}
    frame_index = None if record.frame is None else record.frame.frame_index
    if isinstance(record, SegmentationBoxRecord):
        return _with_confidence(
            {
                "kind": record.kind,
                "order": record.order,
                "object_id": record.object_id,
                "frame_index": frame_index,
                "left": record.left,
                "top": record.top,
                "right": record.right,
                "bottom": record.bottom,
            },
            record.confidence,
        )
    if isinstance(record, SegmentationMaskRecord):
        bounds = record.bounds
        return _with_confidence(
            {
                "kind": record.kind,
                "order": record.order,
                "object_id": record.object_id,
                "frame_index": frame_index,
                "identity": {
                    "media": record.identity.media,
                    "frame_index": record.identity.frame_index,
                    "object_id": record.identity.object_id,
                },
                "revision": record.revision,
                "mask": {
                    "encoding": record.mask.encoding,
                    "payload": record.mask.payload,
                    "width": record.mask.width,
                    "height": record.mask.height,
                    "decoded": _decoded_mask(decode_mask_to_raster(record.mask)),
                    "raster": list(decode_mask_to_raster(record.mask)),
                    "coco_rle": {
                        "size": list(decode_mask_to_rle(record.mask).size),
                        "counts": decode_mask_to_rle(record.mask).counts,
                    },
                    "svg_path": decode_mask_to_svg_path(record.mask),
                },
                "bounds": {
                    "left": bounds.left,
                    "top": bounds.top,
                    "right": bounds.right,
                    "bottom": bounds.bottom,
                },
            },
            record.confidence,
        )
    raise AssertionError(f"Unsupported record type: {type(record).__name__}")


def _normalize_view(view: SegmentationSnapshot) -> dict[str, Any]:
    return {
        "media": view.media,
        "revision": view.revision,
        "records": [_normalize_record(record) for record in view.records],
        "diagnostics": [
            {
                "severity": diagnostic.severity,
                "code": diagnostic.code,
                "message": diagnostic.message,
                "line": diagnostic.line,
                "raw": diagnostic.raw,
            }
            for diagnostic in view.diagnostics
        ],
        "raw_output": view.raw_output,
    }


def _normalize_result(result: SegmentationResult) -> dict[str, Any]:
    normalized = _normalize_view(result)
    outcome: dict[str, Any] = {"status": result.outcome.status}
    if isinstance(result.outcome, IncompleteOutcome):
        outcome["reason"] = result.outcome.reason
        if result.outcome.detail is not None:
            outcome["detail"] = result.outcome.detail
    return {**normalized, "outcome": outcome}


def _normalize_lane(lane: OutputTextLane | None) -> dict[str, object] | None:
    if lane is None:
        return None
    return {
        "item_id": lane.item_id,
        "output_index": lane.output_index,
        "content_index": lane.content_index,
    }


def _normalize_error(error: ResponsesStreamError) -> dict[str, object]:
    normalized: dict[str, object] = {"code": error.code, "message": str(error)}
    if isinstance(error, ResponsesStreamLaneError):
        normalized["expected_lane"] = _normalize_lane(error.expected)
        normalized["received_lane"] = _normalize_lane(error.received)
    elif isinstance(error, ResponsesStreamSourceError):
        normalized["source_operation"] = error.operation
    return normalized


def _format(
    case: SharedConformanceCase,
) -> ResponseFormat[SegmentationSnapshot, SegmentationResult]:
    if case.media == "image":
        return cast(
            ResponseFormat[SegmentationSnapshot, SegmentationResult],
            image_segmentation_format(),
        )
    return cast(
        ResponseFormat[SegmentationSnapshot, SegmentationResult],
        video_segmentation_format(),
    )


def _lane(event: dict[str, Any]) -> dict[str, object]:
    return cast(dict[str, object], event["lane"])


def _source_event(
    case: SharedConformanceCase, event: dict[str, Any]
) -> dict[str, object]:
    event_type = event["type"]
    if event_type == "output_text_delta":
        return {
            "type": "response.output_text.delta",
            **_lane(event),
            "delta": case.chunks[cast(int, event["chunk"])],
        }
    if event_type == "output_text_done":
        return {
            "type": "response.output_text.done",
            **_lane(event),
            "text": event["text"],
        }
    if event_type == "content_part_done":
        part_type = event["part_type"]
        part = (
            {"type": "refusal", "refusal": event["text"]}
            if part_type == "refusal"
            else {"type": part_type, "text": event["text"]}
        )
        return {
            "type": "response.content_part.done",
            **_lane(event),
            "part": part,
        }
    if event_type == "response_completed":
        return {"type": "response.completed"}
    if event_type == "response_incomplete":
        detail = event.get("detail")
        return {
            "type": "response.incomplete",
            "response": {
                "incomplete_details": (
                    {"reason": detail} if isinstance(detail, str) else None
                )
            },
        }
    if event_type == "response_failed":
        return {
            "type": "response.failed",
            "response": {"error": {"message": event["message"]}},
        }
    if event_type == "error":
        return {"type": "error", "message": event["message"]}
    if event_type == "refusal_delta":
        return {
            "type": "response.refusal.delta",
            **_lane(event),
            "delta": event["text"],
        }
    if event_type == "refusal_done":
        return {
            "type": "response.refusal.done",
            **_lane(event),
            "refusal": event["text"],
        }
    raise AssertionError(f"Unsupported source event: {event_type}")


class _CaseIterator(AsyncIterator[dict[str, object]]):
    def __init__(self, case: SharedConformanceCase) -> None:
        self._case = case
        self._index = 0

    async def __anext__(self) -> dict[str, object]:
        directive = self._case.source
        if (
            directive is not None
            and directive["operation"] == "next"
            and self._index == directive["after_events"]
        ):
            raise RuntimeError(cast(str, directive["message"]))
        if self._index == len(self._case.events):
            raise StopAsyncIteration
        event = self._case.events[self._index]
        self._index += 1
        return _source_event(self._case, event)

    async def aclose(self) -> None:
        directive = self._case.source
        if directive is not None and directive["operation"] == "close":
            raise RuntimeError(cast(str, directive["message"]))


class _CaseSource(AsyncIterable[dict[str, object]]):
    def __init__(self, case: SharedConformanceCase) -> None:
        self._case = case

    def __aiter__(self) -> AsyncIterator[dict[str, object]]:
        directive = self._case.source
        if directive is not None and directive["operation"] == "iterator":
            raise RuntimeError(cast(str, directive["message"]))
        return _CaseIterator(self._case)


async def _run_stream_case(case: SharedConformanceCase) -> dict[str, Any]:
    parsed = parse_responses_stream(_CaseSource(case), _format(case))
    snapshots: list[dict[str, Any]] = []
    try:
        async for snapshot in parsed:
            snapshots.append(_normalize_view(snapshot))
        result = await parsed.final_result()
    except ResponsesStreamError as error:
        return {"snapshots": snapshots, "error": _normalize_error(error)}
    return {"snapshots": snapshots, "result": _normalize_result(result)}


@pytest.mark.conformance
@pytest.mark.parametrize("case", _CASES, ids=lambda case: case.name)
def test_shared_stream_conformance(case: SharedConformanceCase) -> None:
    assert asyncio.run(_run_stream_case(case)) == case.expected


@pytest.mark.conformance
def test_python_loader_rejects_parser_options(tmp_path: Path) -> None:
    source = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "conformance"
            / "cases"
            / "source-done-only.json"
        ).read_text(encoding="utf-8")
    )
    source["options"] = {}
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(source), encoding="utf-8")
    with pytest.raises(AssertionError, match="failed schema validation"):
        _load_case(path)


@pytest.mark.conformance
def test_all_shared_cases_execute_through_the_stream_adapter() -> None:
    assert len(_CASES) == 40
