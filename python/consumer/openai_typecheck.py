# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

from openai import AsyncStream
from openai.types.responses import ResponseStreamEvent

from meta_sam_parser import (
    ParsedResponsesStream,
    VideoSegmentationResult,
    VideoSegmentationSnapshot,
    parse_responses_stream,
    video_segmentation_format,
)


async def consume(
    source: AsyncStream[ResponseStreamEvent],
) -> VideoSegmentationResult:
    parsed: ParsedResponsesStream[
        VideoSegmentationSnapshot, VideoSegmentationResult
    ] = parse_responses_stream(source, video_segmentation_format())
    async with parsed:
        async for snapshot in parsed:
            _revision: int = snapshot.revision
    return await parsed.final_result()
