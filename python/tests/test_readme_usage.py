# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
import pathlib
from collections.abc import AsyncIterator

import pytest

from meta_sam_parser import (
    ResponsesEventLike,
    ResponsesStreamAbortedError,
    ResponsesStreamConsumedError,
    SegmentationMaskRecord,
    VideoSegmentationResult,
    VideoSegmentationSnapshot,
    decode_mask_to_raster,
    decode_mask_to_rle,
    decode_mask_to_svg_path,
    parse_responses_stream,
    video_segmentation_format,
)

# The README input: frame 0 of a 320x334 clip, two objects, as the SAM API emits
# it. Keep identical to python/README.md so its comments stay true.
_OUTPUT_TEXT = (
    "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>"
    "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>"
    ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>"
    "<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n"
)


async def _response_events() -> AsyncIterator[ResponsesEventLike]:
    # Split inside the line: the second delta completes it.
    first_line_end = _OUTPUT_TEXT.index(",1<|box")
    yield {
        "type": "response.output_text.delta",
        "item_id": "message-1",
        "output_index": 0,
        "content_index": 0,
        "delta": _OUTPUT_TEXT[:first_line_end],
    }
    yield {
        "type": "response.output_text.delta",
        "item_id": "message-1",
        "output_index": 0,
        "content_index": 0,
        "delta": _OUTPUT_TEXT[first_line_end:],
    }
    yield {
        "type": "response.output_text.done",
        "item_id": "message-1",
        "output_index": 0,
        "content_index": 0,
        "text": _OUTPUT_TEXT,
    }
    yield {"type": "response.completed"}


def test_readme_iterator_first_usage() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_response_events(), video_segmentation_format())
        snapshots: list[VideoSegmentationSnapshot] = []
        async with parsed:
            async for snapshot in parsed:
                snapshots.append(snapshot)
        result: VideoSegmentationResult = await parsed.final_result()

        # The line completes with the second delta, so one snapshot of 4 records.
        assert [len(snapshot.records) for snapshot in snapshots] == [4]
        assert result.outcome.status == "completed"
        assert result.diagnostics == ()
        assert [record.kind for record in result.records] == [
            "box",
            "mask",
            "box",
            "mask",
        ]
        masks = [
            record
            for record in result.records
            if isinstance(record, SegmentationMaskRecord)
        ]
        assert [mask.object_id for mask in masks] == ["0", "1"]
        assert all(
            mask.frame is not None and mask.frame.frame_index == 0 for mask in masks
        )
        mask = masks[0]
        assert mask.identity.object_id == "0"
        assert (mask.mask.encoding, mask.mask.width, mask.mask.height) == (
            "lossless",
            60,
            27,
        )
        # Inclusive wire corners become half-open bounds.
        assert mask.bounds is not None
        assert (
            mask.bounds.left,
            mask.bounds.top,
            mask.bounds.right,
            mask.bounds.bottom,
        ) == (
            211,
            228,
            271,
            255,
        )
        raster = decode_mask_to_raster(mask.mask)
        assert len(raster) == 27 * 60
        assert set(raster) <= {0, 1}
        assert sum(raster) == 1539
        assert decode_mask_to_rle(mask.mask).size == (27, 60)
        svg_path = decode_mask_to_svg_path(mask.mask)
        assert svg_path.startswith("M") and svg_path.endswith("Z")
        assert len(decode_mask_to_raster(masks[1].mask)) == 27 * 48

    asyncio.run(run())


def test_readme_final_only_usage() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_response_events(), video_segmentation_format())
        result = await parsed.final_result()
        assert [record.kind for record in result.records] == [
            "box",
            "mask",
            "box",
            "mask",
        ]
        with pytest.raises(ResponsesStreamConsumedError):
            aiter(parsed)

    asyncio.run(run())


def test_readme_early_exit_and_explicit_ownership() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_response_events(), video_segmentation_format())
        try:
            iterator = aiter(parsed)
            snapshot = await anext(iterator)
            assert snapshot.records
        finally:
            await parsed.aclose()
        with pytest.raises(ResponsesStreamAbortedError):
            await parsed.final_result()

    asyncio.run(run())


def test_readme_output_text_matches_readme() -> None:
    readme = (pathlib.Path(__file__).resolve().parents[1] / "README.md").read_text(
        encoding="utf-8"
    )
    for fragment in (
        '"<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>"',
        '",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>"',
        "data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>",
        "data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>",
    ):
        assert fragment in readme
