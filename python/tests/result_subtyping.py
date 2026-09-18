# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

"""Strict-mypy consumer assertions for final-result snapshot subtyping."""

from meta_sam_parser import (
    ImageSegmentationResult,
    ImageSegmentationSnapshot,
    SegmentationResult,
    SegmentationSnapshot,
    VideoSegmentationResult,
    VideoSegmentationSnapshot,
)


def consume_image_snapshot(value: ImageSegmentationSnapshot) -> int:
    return value.revision


def consume_video_snapshot(value: VideoSegmentationSnapshot) -> int:
    return value.revision


def consume_snapshot(value: SegmentationSnapshot) -> int:
    return value.revision


def image_result_is_snapshot(value: ImageSegmentationResult) -> int:
    return consume_image_snapshot(value) + consume_snapshot(value)


def video_result_is_snapshot(value: VideoSegmentationResult) -> int:
    return consume_video_snapshot(value) + consume_snapshot(value)


def any_result_is_snapshot(value: SegmentationResult) -> int:
    return consume_snapshot(value)
