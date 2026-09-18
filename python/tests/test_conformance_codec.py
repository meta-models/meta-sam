# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

import pytest
from conformance_vectors import SharedMaskVector, load_shared_mask_vectors

from meta_sam_parser import (
    RLEObject,
    SegmentationMask,
    decode_mask_to_raster,
    decode_mask_to_rle,
    decode_mask_to_svg_path,
)

_VECTORS = load_shared_mask_vectors()


@pytest.mark.conformance
@pytest.mark.parametrize("vector", _VECTORS, ids=lambda vector: vector.test_id)
def test_shared_complete_mask_vectors(vector: SharedMaskVector) -> None:
    mask = SegmentationMask(
        encoding=vector.encoding,
        payload=vector.payload,
        width=vector.width,
        height=vector.height,
    )
    assert decode_mask_to_raster(mask) == vector.decoded == vector.raster
    assert decode_mask_to_rle(mask) == RLEObject(
        size=vector.coco_rle.size,
        counts=vector.coco_rle.counts,
    )
    assert decode_mask_to_svg_path(mask) == vector.svg_path


@pytest.mark.conformance
def test_shared_vectors_cover_every_complete_mask_encoding() -> None:
    assert {vector.encoding for vector in _VECTORS} == {"one_bit", "lossless"}
