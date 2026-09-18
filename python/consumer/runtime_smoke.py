# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from pathlib import Path

import meta_sam_parser
from meta_sam_parser import (
    CompletedOutcome,
    ResponsesEventLike,
    ResponsesStreamAbortedError,
    ResponsesStreamLaneError,
    RLEObject,
    SegmentationMask,
    SegmentationMaskRecord,
    decode_mask_to_raster,
    decode_mask_to_rle,
    decode_mask_to_svg_path,
    parse_responses_stream,
    video_segmentation_format,
)

_OUTPUT = (
    "<7f>0<|box;x1=10;y1=20;x2=14;y2=24;w=200;h=100|>"
    "<|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n"
    "<8f>0<|box;x1=11;y1=20;x2=15;y2=24;w=200;h=100|>"
    "<|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n"
)
_LANE = {"item_id": "message-1", "output_index": 0, "content_index": 0}


async def _events(*events: ResponsesEventLike) -> AsyncIterator[ResponsesEventLike]:
    for event in events:
        yield event


class _TrackedIterator(AsyncIterator[ResponsesEventLike]):
    def __init__(self, events: tuple[ResponsesEventLike, ...]) -> None:
        self._events = events
        self._index = 0
        self.close_count = 0

    async def __anext__(self) -> ResponsesEventLike:
        if self._index == len(self._events):
            raise StopAsyncIteration
        event = self._events[self._index]
        self._index += 1
        return event

    async def aclose(self) -> None:
        self.close_count += 1


class _TrackedSource:
    def __init__(self, *events: ResponsesEventLike) -> None:
        self.iterator = _TrackedIterator(events)

    def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
        return self.iterator


def _stream_events() -> tuple[ResponsesEventLike, ...]:
    line_end = _OUTPUT.index("\n") + 1
    return (
        {
            "type": "response.output_text.delta",
            **_LANE,
            "delta": _OUTPUT[:line_end],
        },
        {
            "type": "response.output_text.delta",
            **_LANE,
            "delta": _OUTPUT[line_end:],
        },
        {"type": "response.output_text.done", **_LANE, "text": _OUTPUT},
        {"type": "response.completed"},
    )


def _check_installed_import() -> None:
    source_root = Path(os.environ["META_SAM_SOURCE_ROOT"]).resolve()
    module_path = Path(meta_sam_parser.__file__).resolve()
    if module_path.is_relative_to(source_root):
        raise AssertionError(f"import resolved to source tree: {module_path}")


def _check_codec_and_direct_parser() -> None:
    mask = SegmentationMask(
        encoding="one_bit", payload="!!!!!(QO(0lu8?", width=5, height=5
    )
    expected = bytes(int(value) for value in "1001000110000001011110001")
    assert decode_mask_to_raster(mask) == expected
    assert decode_mask_to_rle(mask) == RLEObject((5, 5), "01214OK0010O31")
    assert decode_mask_to_svg_path(mask).startswith("M-0.5 0L0 -0.5")

    parser = video_segmentation_format().create_parser()
    assert len(parser.push(_OUTPUT.splitlines(keepends=True)[0])) == 1
    assert len(parser.push(_OUTPUT.splitlines(keepends=True)[1])) == 1
    result = parser.finish(CompletedOutcome()).result
    assert [record.kind for record in result.records] == ["box", "mask", "box", "mask"]
    mask_record = next(
        record
        for record in result.records
        if isinstance(record, SegmentationMaskRecord)
    )
    assert decode_mask_to_raster(mask_record.mask) == expected


async def _check_stream_modes() -> None:
    parsed = parse_responses_stream(
        _events(*_stream_events()), video_segmentation_format()
    )
    snapshots = []
    async with parsed:
        async for snapshot in parsed:
            snapshots.append(snapshot)
    assert [len(snapshot.records) for snapshot in snapshots] == [2, 4]
    assert (await parsed.final_result()).outcome.status == "completed"

    final_only = parse_responses_stream(
        _events(*_stream_events()), video_segmentation_format()
    )
    result = await final_only.final_result()
    assert [record.kind for record in result.records] == ["box", "mask", "box", "mask"]

    source = _TrackedSource(*_stream_events())
    early = parse_responses_stream(source, video_segmentation_format())
    async with early:
        assert (await anext(aiter(early))).records
    try:
        await early.final_result()
    except ResponsesStreamAbortedError:
        pass
    else:
        raise AssertionError("early close did not abort the final result")
    assert source.iterator.close_count == 1

    interleaved = parse_responses_stream(
        _events(
            {
                "type": "response.output_text.delta",
                **_LANE,
                "delta": "first",
            },
            {
                "type": "response.output_text.delta",
                "item_id": "message-2",
                "output_index": 1,
                "content_index": 0,
                "delta": "second",
            },
        ),
        video_segmentation_format(),
    )
    try:
        await interleaved.final_result()
    except ResponsesStreamLaneError:
        pass
    else:
        raise AssertionError("interleaved lanes did not fail")


def main() -> None:
    _check_installed_import()
    _check_codec_and_direct_parser()
    asyncio.run(_check_stream_modes())
    print(
        "runtime smoke: codec, segmentation, iterator-first, final-only, "
        "early-close, and error cases passed"
    )


if __name__ == "__main__":
    main()
