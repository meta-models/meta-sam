# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterable
from pathlib import Path
from typing import cast

from meta_sam_parser import (
    ResponsesEventLike,
    SegmentationBoxRecord,
    SegmentationMaskRecord,
    decode_mask_to_raster,
    image_segmentation_format,
    parse_responses_stream,
    video_segmentation_format,
)

_FIXTURES = Path(__file__).with_name("fixtures")
Event = dict[str, object]


def _load_fixture(name: str) -> list[Event]:
    value: object = json.loads((_FIXTURES / name).read_text())
    assert isinstance(value, list)
    assert all(isinstance(event, dict) for event in value)
    return cast(list[Event], value)


async def _events(values: Iterable[Event]) -> AsyncIterator[ResponsesEventLike]:
    for value in values:
        yield value


def _delta_text(events: Iterable[Event]) -> str:
    return "".join(
        cast(str, event["delta"])
        for event in events
        if event.get("type") == "response.output_text.delta"
    )


def test_live_image_wheel_content_part_done_finalizes_output_text() -> None:
    async def run() -> None:
        events = _load_fixture("live_image_wheel.events.json")
        result = await parse_responses_stream(
            _events(events), image_segmentation_format()
        ).final_result()

        assert result.outcome.status == "completed"
        assert result.diagnostics == ()
        assert [record.kind for record in result.records] == ["box", "mask"] * 4
        assert [
            record.object_id
            for record in result.records
            if isinstance(record, (SegmentationBoxRecord, SegmentationMaskRecord))
        ] == ["0", "0", "1", "1", "2", "2", "3", "3"]
        object_zero = [
            record
            for record in result.records
            if isinstance(record, (SegmentationBoxRecord, SegmentationMaskRecord))
            and record.object_id == "0"
        ]
        assert [record.kind for record in object_zero] == ["box", "mask"]
        mask = cast(SegmentationMaskRecord, object_zero[1])
        assert (
            len(decode_mask_to_raster(mask.mask)) == mask.mask.width * mask.mask.height
        )
        assert result.raw_output == _delta_text(events)

    asyncio.run(run())


def test_live_video_pillow_three_frames_content_part_done_finalizes_output_text() -> (
    None
):
    async def run() -> None:
        events = _load_fixture("live_video_pillow_3frames.events.json")
        result = await parse_responses_stream(
            _events(events), video_segmentation_format()
        ).final_result()

        assert result.outcome.status == "completed"
        assert result.diagnostics == ()
        assert {
            record.frame.frame_index
            for record in result.records
            if isinstance(record, (SegmentationBoxRecord, SegmentationMaskRecord))
            and record.frame is not None
        } == {0, 1, 2}
        assert result.raw_output == _delta_text(events)

    asyncio.run(run())
