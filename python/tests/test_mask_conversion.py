# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

import meta_sam_parser
from meta_sam_parser import (
    InvalidSegmentationMaskError,
    RLEObject,
    SegmentationMask,
    decode_mask_to_raster,
    decode_mask_to_rle,
    decode_mask_to_svg_path,
)
from meta_sam_parser import _mask_codec as codec
from meta_sam_parser import _mask_conversion as conversion

_SHAPES = (
    (
        "empty",
        4,
        4,
        bytes(16),
        RLEObject((4, 4), "`0"),
        "",
    ),
    (
        "single pixel",
        2,
        2,
        bytes((1, 0, 0, 0)),
        RLEObject((2, 2), "013"),
        "M-0.5 0L0 -0.5L0.5 0L0 0.5Z",
    ),
    (
        "filled",
        2,
        2,
        bytes((1, 1, 1, 1)),
        RLEObject((2, 2), "04"),
        "M-0.5 0L0 -0.5L1 -0.5L1.5 0L1.5 1L1 1.5L0 1.5L-0.5 1Z",
    ),
    (
        "full column",
        2,
        4,
        bytes((1, 0, 1, 0, 1, 0, 1, 0)),
        RLEObject((4, 2), "044"),
        "M-0.5 0L0 -0.5L0.5 0L0.5 1L0.5 2L0.5 3L0 3.5L-0.5 3L-0.5 2L-0.5 1Z",
    ),
    (
        "disconnected",
        1,
        6,
        bytes((1, 1, 0, 0, 1, 1)),
        RLEObject((6, 1), "0220"),
        "M-0.5 0L0 -0.5L0.5 0L0.5 1L0 1.5L-0.5 1Z"
        "M-0.5 4L0 3.5L0.5 4L0.5 5L0 5.5L-0.5 5Z",
    ),
    (
        "L",
        3,
        3,
        bytes((1, 0, 0, 1, 0, 0, 1, 1, 1)),
        RLEObject((3, 3), "032N00"),
        "M-0.5 0L0 -0.5L0.5 0L0.5 1L1 1.5L2 1.5L2.5 2L2 2.5L1 2.5L0 2.5L-0.5 2L-0.5 1Z",
    ),
    (
        "diagonal",
        3,
        3,
        bytes((1, 0, 0, 0, 1, 0, 0, 0, 1)),
        RLEObject((3, 3), "013000"),
        "M-0.5 0L0 -0.5L0.5 0L1 0.5L1.5 1L2 1.5L2.5 2L2 2.5L1.5 2L1 1.5L0.5 1L0 0.5Z",
    ),
    (
        "checkerboard",
        2,
        2,
        bytes((1, 0, 0, 1)),
        RLEObject((2, 2), "0120"),
        "M-0.5 0L0 -0.5L0.5 0L1 0.5L1.5 1L1 1.5L0.5 1L0 0.5Z",
    ),
)


def _mask(raster: bytes, width: int, height: int) -> SegmentationMask:
    return SegmentationMask(
        "one_bit", codec._encode_raster(raster, width, height), width, height
    )


@pytest.mark.parametrize(
    "_name,width,height,raster,rle,svg", _SHAPES, ids=lambda value: str(value)
)
def test_exact_raster_coco_rle_and_svg_outputs(
    _name: str,
    width: int,
    height: int,
    raster: bytes,
    rle: RLEObject,
    svg: str,
) -> None:
    mask = _mask(raster, width, height)
    assert decode_mask_to_raster(mask) == raster
    assert decode_mask_to_rle(mask) == rle
    assert decode_mask_to_svg_path(mask) == svg


def test_asymmetric_non_square_transpose_and_coco_round_trip() -> None:
    raster = bytes((0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1))
    mask = _mask(raster, 3, 6)
    rle = decode_mask_to_rle(mask)
    assert rle == RLEObject((6, 3), "543OON")

    column_major = conversion._decode(rle).data
    round_trip = bytearray(len(raster))
    for row in range(mask.height):
        for col in range(mask.width):
            round_trip[row * mask.width + col] = column_major[col * mask.height + row]
    assert bytes(round_trip) == raster


def test_compressed_counts_match_javascript_signed_32_bit_coding() -> None:
    cases = (
        ((1 << 31) - 1, "oooooo1", (1 << 31) - 1),
        (1 << 31, "PPPPPPN", -8),
        ((1 << 31) + 1, "QPPPPPN", -7),
        ((1 << 32) - 1, "O", -1),
    )
    for count, encoded, decoded in cases:
        assert (
            conversion._rle_to_string(conversion._RLE(1, count, 1, [count])) == encoded
        )
        result = conversion._RLE(0, 0, 0, [])
        conversion._rle_from_string(result, encoded, 1, count)
        assert result.cnts == [decoded]


def test_one_bit_and_lossless_representations_convert_identically() -> None:
    raster = bytes((0, 0, 1, 1, 0, 1))
    one_bit = _mask(raster, 3, 2)
    lossless = SegmentationMask("lossless", "~!!!!.!0^zlTde]:)]`W", 3, 2)
    assert decode_mask_to_raster(one_bit) == decode_mask_to_raster(lossless)
    assert decode_mask_to_rle(one_bit) == decode_mask_to_rle(lossless)
    assert decode_mask_to_svg_path(one_bit) == decode_mask_to_svg_path(lossless)


def test_malformed_masks_fail_consistently_through_all_conversions() -> None:
    malformed = SegmentationMask("one_bit", "!", 1, 1)
    messages = []
    for convert in (
        decode_mask_to_raster,
        decode_mask_to_rle,
        decode_mask_to_svg_path,
    ):
        with pytest.raises(InvalidSegmentationMaskError) as raised:
            convert(malformed)
        messages.append(str(raised.value))
    assert messages == ["Mask payload is missing its length prefix."] * 3


def test_root_only_public_api_and_frozen_slotted_rle_type() -> None:
    rle = RLEObject((1, 1), "1")
    assert RLEObject.__slots__ == ("size", "counts")
    assert not hasattr(rle, "__dict__")
    with pytest.raises(FrozenInstanceError):
        rle.counts = "2"  # type: ignore[misc]
    assert {
        "RLEObject",
        "decode_mask_to_raster",
        "decode_mask_to_rle",
        "decode_mask_to_svg_path",
    } <= set(meta_sam_parser.__all__)
    old_name = "_".join(("decode", "segmentation", "mask"))
    assert not hasattr(meta_sam_parser, old_name)
