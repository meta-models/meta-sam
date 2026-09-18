# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

from collections.abc import AsyncIterable

from meta_sam_parser import (
    ParsedResponsesStream,
    ResponsesEventLike,
    RLEObject,
    SegmentationMask,
    VideoSegmentationResult,
    VideoSegmentationSnapshot,
    decode_mask_to_raster,
    decode_mask_to_rle,
    decode_mask_to_svg_path,
    parse_responses_stream,
    video_segmentation_format,
)


def decode(mask: SegmentationMask) -> tuple[bytes, RLEObject, str]:
    return (
        decode_mask_to_raster(mask),
        decode_mask_to_rle(mask),
        decode_mask_to_svg_path(mask),
    )


async def consume(
    source: AsyncIterable[ResponsesEventLike],
) -> VideoSegmentationResult:
    parsed: ParsedResponsesStream[
        VideoSegmentationSnapshot, VideoSegmentationResult
    ] = parse_responses_stream(source, video_segmentation_format())
    async with parsed:
        async for snapshot in parsed:
            _revision: int = snapshot.revision
    return await parsed.final_result()
