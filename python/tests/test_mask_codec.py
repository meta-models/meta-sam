# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

from dataclasses import FrozenInstanceError
from typing import Any, cast

import pytest
from conformance_vectors import SharedMaskVector, load_shared_mask_vectors

import meta_sam_parser
from meta_sam_parser import (
    InvalidSegmentationMaskError,
    ResponsesStreamError,
    SegmentationMask,
    decode_mask_to_raster,
)
from meta_sam_parser import _mask_codec as codec

_VECTORS = load_shared_mask_vectors()


def _vector(encoding: str, case_name: str) -> SharedMaskVector:
    return next(
        vector
        for vector in _VECTORS
        if vector.encoding == encoding and vector.case_name == case_name
    )


def _mask(
    payload: str,
    *,
    encoding: object = "one_bit",
    width: object = 5,
    height: object = 5,
) -> SegmentationMask:
    return SegmentationMask(
        encoding=cast(Any, encoding),
        payload=payload,
        width=cast(Any, width),
        height=cast(Any, height),
    )


def _assert_invalid(mask: SegmentationMask, message: str) -> None:
    with pytest.raises(InvalidSegmentationMaskError, match=message) as raised:
        decode_mask_to_raster(mask)
    assert raised.value.code == "invalid_mask_payload"


def test_public_api_remains_root_only_and_typed() -> None:
    assert {
        "InvalidSegmentationMaskError",
        "ResponsesStreamError",
        "SegmentationMask",
        "decode_mask_to_raster",
    } <= set(meta_sam_parser.__all__)
    assert not hasattr(meta_sam_parser, "encode_segmentation_mask")


def test_mask_type_and_decoded_raster_are_immutable() -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    mask = SegmentationMask(
        vector.encoding, vector.payload, vector.width, vector.height
    )
    with pytest.raises(FrozenInstanceError):
        mask.width = 1  # type: ignore[misc]
    decoded = decode_mask_to_raster(mask)
    assert isinstance(decoded, bytes)
    with pytest.raises(TypeError):
        decoded[0] = 0  # type: ignore[index]


def test_error_hierarchy_preserves_stable_invalid_mask_code() -> None:
    invalid = InvalidSegmentationMaskError("invalid")
    assert isinstance(invalid, ResponsesStreamError)
    assert invalid.code == "invalid_mask_payload"


def test_lossless_threshold_is_strictly_129() -> None:
    vector = _vector("lossless", "compact-api-image-lossless")
    coverage = codec._decode_lossless_raster(
        vector.payload, vector.width, vector.height
    )
    assert coverage[1:3] == bytes([128, 129])
    decoded = decode_mask_to_raster(
        SegmentationMask(vector.encoding, vector.payload, vector.width, vector.height)
    )
    assert decoded == vector.decoded
    assert decoded[1:3] == bytes([0, 1])


def test_lossless_accepts_nonunique_trailing_and_finalization_variants() -> None:
    vector = _vector("lossless", "compact-api-image-lossless")
    packed = codec._unpack(vector.payload[1:])
    alternate_finalization = bytearray(packed)
    alternate_finalization[-4] = 0
    variants = (
        f"~{codec._pack(packed + bytes([0]))}",
        f"~{codec._pack(alternate_finalization)}",
    )

    assert all(payload != vector.payload for payload in variants)
    for payload in variants:
        assert codec._unpack(payload[1:])
        assert (
            decode_mask_to_raster(
                SegmentationMask("lossless", payload, vector.width, vector.height)
            )
            == vector.decoded
        )


@pytest.mark.parametrize("width,height", [(1, 1), (2, 2), (3, 3)])
def test_every_small_one_bit_raster_round_trips(width: int, height: int) -> None:
    area = width * height
    for value in range(1 << area):
        raster = bytes((value >> offset) & 1 for offset in range(area))
        payload = codec._encode_raster(raster, width, height)
        assert (
            decode_mask_to_raster(SegmentationMask("one_bit", payload, width, height))
            == raster
        )


@pytest.mark.parametrize(
    "width,height,raster",
    [
        (5000, 1, bytes(index & 1 for index in range(5000))),
        (1, 5000, bytes((index // 7) & 1 for index in range(5000))),
        (73, 71, bytes((index * 17 + index // 13) & 1 for index in range(5183))),
    ],
)
def test_one_bit_fixed_width_renormalization_and_count_scaling(
    width: int, height: int, raster: bytes
) -> None:
    payload = codec._encode_raster(raster, width, height)
    assert (
        decode_mask_to_raster(SegmentationMask("one_bit", payload, width, height))
        == raster
    )


def test_fixed_width_helpers_match_typed_array_assignments() -> None:
    assert codec._u8(-1) == 0xFF
    assert codec._u8(0x100) == 0
    assert codec._u16(-1) == 0xFFFF
    assert codec._u16(0x10000) == 0
    assert codec._u32(-1) == 0xFFFFFFFF
    assert codec._u32(0x1_0000_0000) == 0
    assert codec._i32(0x7FFFFFFF) == 0x7FFFFFFF
    assert codec._i32(0x80000000) == -0x80000000
    assert codec._i32(0xFFFFFFFF) == -1


@pytest.mark.parametrize("length", range(13))
def test_base85_round_trips_every_tail_width(length: int) -> None:
    raw = bytes((index * 37 + 11) & 0xFF for index in range(length))
    assert codec._unpack(codec._pack(raw)) == raw


def test_base85_rejects_invalid_length_character_and_groups() -> None:
    _assert_invalid(_mask("!"), "missing its length prefix")
    with pytest.raises(InvalidSegmentationMaskError, match="invalid character"):
        codec._unpack("\U0001f600\U0001f600\U0001f600")

    valid = _vector("one_bit", "synthetic-image-chunking")
    _assert_invalid(
        _mask(valid.payload + "!", width=valid.width, height=valid.height),
        "length does not match its prefix",
    )
    _assert_invalid(
        _mask(f"{valid.payload[:-1]}|", width=valid.width, height=valid.height),
        "invalid character",
    )

    four_byte_prefix = codec._pack(bytes(4))[: codec._PREFIX_LENGTH]
    highest = codec._ALPHABET[codec._RADIX - 1]
    _assert_invalid(
        _mask(f"!{four_byte_prefix}{highest * 5}"),
        "out-of-range group",
    )

    one_byte_prefix = codec._pack(bytes(1))[: codec._PREFIX_LENGTH]
    _assert_invalid(
        _mask(f"!{one_byte_prefix}{highest * 2}"),
        "out-of-range tail",
    )


def test_base85_rejects_noncanonical_tail_packing() -> None:
    canonical = codec._pack(bytes(1))
    final_digit = codec._digit(canonical[-1])
    noncanonical = f"{canonical[:-1]}{codec._ALPHABET[final_digit + 1]}"
    _assert_invalid(_mask(f"!{noncanonical}"), "not in canonical form")


def test_one_bit_requires_complete_canonical_range_finalization() -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    raw = codec._unpack(vector.payload[1:])
    malformed = [
        f"!{codec._pack(bytes(3))}",
        f"!{codec._pack(raw[:-1])}",
        f"!{codec._pack(raw + bytes(1))}",
    ]
    for payload in malformed:
        _assert_invalid(
            _mask(payload, width=vector.width, height=vector.height),
            "finalization|decoding completed|not canonical",
        )


def test_lossless_rejects_wrong_prefix_truncation_and_predictor() -> None:
    vector = _vector("lossless", "compact-api-image-lossless")
    _assert_invalid(
        _mask(
            f"!{vector.payload[1:]}",
            encoding="lossless",
            width=vector.width,
            height=vector.height,
        ),
        "must start with ~",
    )
    _assert_invalid(
        _mask(f"~{codec._pack(bytes(4))}", encoding="lossless"),
        "truncated",
    )
    packed = codec._unpack(vector.payload[1:])
    invalid_predictor = f"~{codec._pack(bytes([5]) + packed[1:])}"
    _assert_invalid(
        _mask(
            invalid_predictor,
            encoding="lossless",
            width=vector.width,
            height=vector.height,
        ),
        "invalid predictor",
    )


@pytest.mark.parametrize(
    "value",
    [0, -1, True, 1 << 53, float("nan"), float("inf"), "1"],
)
def test_dimensions_must_be_positive_javascript_safe_integers(value: object) -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    _assert_invalid(
        _mask(vector.payload, width=value, height=vector.height),
        "positive safe integers",
    )
    _assert_invalid(
        _mask(vector.payload, width=vector.width, height=value),
        "positive safe integers",
    )


def test_integral_floats_match_javascript_safe_integer_semantics() -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    assert (
        decode_mask_to_raster(_mask(vector.payload, width=5.0, height=5.0))
        == vector.decoded
    )


def test_former_decoder_thresholds_reach_structural_validation() -> None:
    _assert_invalid(
        _mask("!", width=16_777_217, height=1),
        "missing its length prefix",
    )
    _assert_invalid(
        _mask("!" * 2_000_001, width=1, height=1),
        "length does not match its prefix",
    )


def test_dimension_product_must_be_javascript_safe() -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    _assert_invalid(
        _mask(vector.payload, width=(1 << 53) - 1, height=2),
        "unsafe decoded area",
    )


def test_encoding_and_prefixes_are_strict() -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    _assert_invalid(
        _mask(vector.payload, encoding="rle"),
        "Unsupported complete mask encoding: rle",
    )
    _assert_invalid(
        _mask(f"~{vector.payload[1:]}", width=vector.width, height=vector.height),
        "one_bit mask payloads must start with !",
    )


def test_non_string_payload_is_rejected() -> None:
    mask = SegmentationMask("one_bit", cast(Any, b"!!!!!"), 1, 1)
    _assert_invalid(mask, "payload must be a string")


def test_unexpected_decoder_failures_are_wrapped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    failure = RuntimeError("synthetic failure")

    def fail(_payload: str, _width: int, _height: int) -> bytes:
        raise failure

    monkeypatch.setattr(codec, "_decode_raster", fail)
    with pytest.raises(
        InvalidSegmentationMaskError, match="could not be decoded"
    ) as raised:
        decode_mask_to_raster(
            SegmentationMask(
                vector.encoding, vector.payload, vector.width, vector.height
            )
        )
    assert raised.value.__cause__ is failure


def test_memory_errors_propagate_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vector = _vector("one_bit", "synthetic-image-chunking")
    failure = MemoryError("synthetic allocation failure")

    def fail(_payload: str, _width: int, _height: int) -> bytes:
        raise failure

    monkeypatch.setattr(codec, "_decode_raster", fail)
    with pytest.raises(MemoryError) as raised:
        decode_mask_to_raster(
            SegmentationMask(
                vector.encoding, vector.payload, vector.width, vector.height
            )
        )
    assert raised.value is failure


def test_private_codec_guards_and_predictors() -> None:
    with pytest.raises(InvalidSegmentationMaskError, match="must start with ~"):
        codec._decode_lossless_raster("!invalid", 1, 1)
    with pytest.raises(InvalidSegmentationMaskError, match="not binary"):
        codec._encode_raster(bytes([2]), 1, 1)

    output = bytearray([10, 20, 0, 30, 0])
    assert codec._predict_byte(output, 4, 1, 1, 0, 3) == 30
    assert codec._predict_byte(output, 4, 1, 1, 1, 3) == 20
    assert codec._predict_byte(output, 4, 1, 1, 2, 3) == 30
    assert codec._predict_byte(output, 4, 1, 1, 3, 3) == 25
    assert codec._predict_byte(output, 4, 1, 1, 4, 3) == 30

    output[0] = 40
    assert codec._predict_byte(output, 4, 1, 1, 4, 3) == 20
    output[0] = 25
    assert codec._predict_byte(output, 4, 1, 1, 4, 3) == 25
    assert codec._paeth(0, 10, 0) == 10
    assert codec._paeth(100, 0, 50) == 50


def test_range_codec_fixed_width_bottom_and_invalid_state_guards() -> None:
    encoder = codec._RangeEncoder()
    encoder._low = 0xFFFFFFFF
    encoder._range = 1
    encoder.encode(0, 1, 1)
    assert len(encoder.finish()) >= 5

    decoder = codec._RangeDecoder(bytes(16))
    decoder._low = 0xFFFFFFFF
    decoder._range = 1
    decoder._scaled = 1
    decoder.decode(0, 1)

    decoder._range = 1
    with pytest.raises(InvalidSegmentationMaskError, match="invalid coding state"):
        decoder.frequency(2)
