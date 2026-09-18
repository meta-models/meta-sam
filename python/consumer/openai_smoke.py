# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from importlib.metadata import version
from pathlib import Path

from openai import AsyncStream
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseStreamEvent,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
)

import meta_sam_parser
from meta_sam_parser import (
    ResponsesStreamAbortedError,
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


async def _events() -> AsyncIterator[ResponseStreamEvent]:
    line_end = _OUTPUT.index("\n") + 1
    yield ResponseTextDeltaEvent(
        content_index=0,
        delta=_OUTPUT[:line_end],
        item_id="message-1",
        logprobs=[],
        output_index=0,
        sequence_number=1,
        type="response.output_text.delta",
    )
    yield ResponseTextDeltaEvent(
        content_index=0,
        delta=_OUTPUT[line_end:],
        item_id="message-1",
        logprobs=[],
        output_index=0,
        sequence_number=2,
        type="response.output_text.delta",
    )
    yield ResponseTextDoneEvent(
        content_index=0,
        item_id="message-1",
        logprobs=[],
        output_index=0,
        sequence_number=3,
        text=_OUTPUT,
        type="response.output_text.done",
    )
    yield ResponseCompletedEvent(
        response=Response(
            id="resp-1",
            created_at=0.0,
            model="gpt-4.1",
            object="response",
            output=[],
            parallel_tool_calls=True,
            tool_choice="auto",
            tools=[],
            status="completed",
        ),
        sequence_number=4,
        type="response.completed",
    )


class _FakeResponse:
    def __init__(self) -> None:
        self.close_count = 0

    async def aclose(self) -> None:
        self.close_count += 1


def _official_stream() -> tuple[AsyncStream[ResponseStreamEvent], _FakeResponse]:
    stream = object.__new__(AsyncStream)
    response = _FakeResponse()
    stream.response = response
    stream._iterator = _events()
    return stream, response


async def _main() -> None:
    if version("openai") != "2.26.0":
        raise AssertionError("OpenAI compatibility smoke requires openai 2.26.0")
    source_root = Path(os.environ["META_SAM_SOURCE_ROOT"]).resolve()
    module_path = Path(meta_sam_parser.__file__).resolve()
    if module_path.is_relative_to(source_root):
        raise AssertionError(f"import resolved to source tree: {module_path}")

    unstarted_stream, unstarted_response = _official_stream()
    unstarted = parse_responses_stream(unstarted_stream, video_segmentation_format())
    await unstarted.aclose()
    assert unstarted_response.close_count == 1
    try:
        await unstarted.final_result()
    except ResponsesStreamAbortedError:
        pass
    else:
        raise AssertionError("Closing an unstarted official stream must abort it")
    await unstarted.aclose()
    assert unstarted_response.close_count == 1

    stream, response = _official_stream()
    parsed = parse_responses_stream(stream, video_segmentation_format())
    snapshots = []
    async with parsed:
        async for snapshot in parsed:
            snapshots.append(snapshot)
    result = await parsed.final_result()
    mask = next(
        record
        for record in result.records
        if isinstance(record, SegmentationMaskRecord)
    )

    assert [len(snapshot.records) for snapshot in snapshots] == [2, 4]
    assert [record.kind for record in result.records] == ["box", "mask", "box", "mask"]
    assert result.outcome.status == "completed"
    assert result.diagnostics == ()
    assert response.close_count == 1
    assert decode_mask_to_raster(mask.mask) == bytes(
        int(value) for value in "1001000110000001011110001"
    )
    assert decode_mask_to_rle(mask.mask).counts == "01214OK0010O31"
    assert decode_mask_to_svg_path(mask.mask).startswith("M-0.5 0L0 -0.5")
    print("official OpenAI 2.26.0 attribute-object event smoke passed")


asyncio.run(_main())
