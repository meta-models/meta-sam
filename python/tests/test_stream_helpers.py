# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any, cast

import pytest

from meta_sam_parser import (
    ParsedResponsesStream,
    ResponsesEventLike,
    SegmentationBoxRecord,
    SegmentationMaskRecord,
    SegmentationResult,
    image_segmentation_format,
    parse_image_stream,
    parse_responses_stream,
    parse_video_stream,
    records_of_kind,
    video_segmentation_format,
)

_BOX = "<|box;x1=3;y1=4;x2=7;y2=8;w=20;h=10|>"
_MASK = "<|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>"
_IMAGE_TEXT = f"<0f>4{_BOX}{_MASK},5{_BOX}{_MASK}\n"
_VIDEO_TEXT = f"<0f>1{_BOX}{_MASK}\n<1f>1{_BOX}{_MASK}\n<2f>1{_BOX}{_MASK}\n"


async def _events(text: str) -> AsyncIterator[ResponsesEventLike]:
    lane = {"item_id": "message-1", "output_index": 0, "content_index": 0}
    yield {"type": "response.output_text.delta", "delta": text, **lane}
    yield {
        "type": "response.content_part.done",
        "part": {"type": "output_text", "text": text},
        **lane,
    }
    yield {"type": "response.completed"}


def _final(make: Callable[[], ParsedResponsesStream[Any, Any]]) -> SegmentationResult:
    async def run() -> SegmentationResult:
        return cast(SegmentationResult, await make().final_result())

    return asyncio.run(run())


def test_parse_image_stream_matches_the_image_format() -> None:
    helper = _final(lambda: parse_image_stream(_events(_IMAGE_TEXT)))
    generic = _final(
        lambda: parse_responses_stream(
            _events(_IMAGE_TEXT), image_segmentation_format()
        )
    )

    assert helper == generic
    assert helper.media == "image"
    assert len(helper.records) == 4


def test_parse_video_stream_matches_the_video_format() -> None:
    helper = _final(lambda: parse_video_stream(_events(_VIDEO_TEXT)))
    generic = _final(
        lambda: parse_responses_stream(
            _events(_VIDEO_TEXT), video_segmentation_format()
        )
    )

    assert helper == generic
    assert helper.media == "video"
    # records_of_kind narrows to box records, which carry a frame.
    boxes = records_of_kind(helper.records, "box")
    assert [box.frame.frame_index for box in boxes if box.frame is not None] == [
        0,
        1,
        2,
    ]


def test_parse_video_stream_yields_snapshots() -> None:
    async def run() -> list[int]:
        counts = []
        async with parse_video_stream(_events(_VIDEO_TEXT)) as parsed:
            async for snapshot in parsed:
                counts.append(len(snapshot.records))
        return counts

    counts = asyncio.run(run())
    assert counts
    assert counts[-1] == 6


def test_records_of_kind_selects_one_kind_in_order() -> None:
    result = _final(lambda: parse_image_stream(_events(_IMAGE_TEXT)))

    boxes = records_of_kind(result.records, "box")
    masks = records_of_kind(result.records, "mask")

    assert isinstance(boxes, tuple)
    assert all(isinstance(record, SegmentationBoxRecord) for record in boxes)
    assert all(isinstance(record, SegmentationMaskRecord) for record in masks)
    assert [record.object_id for record in boxes] == ["4", "5"]
    assert [record.object_id for record in masks] == ["4", "5"]
    assert boxes == (result.records[0], result.records[2])
    assert masks == (result.records[1], result.records[3])
    assert records_of_kind(result.records, "text") == ()
    assert records_of_kind([], "mask") == ()


def test_records_of_kind_refuses_an_unknown_kind() -> None:
    with pytest.raises(ValueError, match="'masks'"):
        records_of_kind((), "masks")  # type: ignore[call-overload]
