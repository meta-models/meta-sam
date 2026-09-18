# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

from dataclasses import FrozenInstanceError, fields
from typing import Any, cast

import pytest

import meta_sam_parser
from meta_sam_parser import (
    CompletedOutcome,
    FrameReference,
    ImageSegmentationResult,
    ImageSegmentationSnapshot,
    IncompleteOutcome,
    InvalidSegmentationMaskError,
    ParserFinish,
    ResponseFormat,
    ResponseFormatParser,
    SegmentationBoxRecord,
    SegmentationDiagnostic,
    SegmentationMask,
    SegmentationMaskBounds,
    SegmentationMaskIdentity,
    SegmentationMaskRecord,
    SegmentationTextRecord,
    VideoSegmentationResult,
    VideoSegmentationSnapshot,
    image_segmentation_format,
    video_segmentation_format,
)
from meta_sam_parser import _segmentation as segmentation

_PAYLOAD = "!!!!!(QO(0lu8?"
_LOSSLESS_PAYLOAD = "~!!!!.!0^zlTde]:)]`W"


def _record(
    object_id: str = "0",
    *,
    x1: int = 0,
    y1: int = 0,
    x2: int = 4,
    y2: int = 4,
    w: int = 20,
    h: int = 20,
    payload: str = _PAYLOAD,
    size: str = "5,5",
) -> str:
    """One SAM API record: object id, box token, mask token."""
    return (
        f"{object_id}<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={w};h={h}|>"
        f"<|mask;x=0;y=0;data={size},{payload}|>"
    )


def _line(frame: int, *records: str) -> str:
    return f"<{frame}f>{','.join(records)}\n"


def _finish_image(
    chunks: tuple[str, ...],
) -> tuple[list[ImageSegmentationSnapshot], ImageSegmentationResult]:
    parser = image_segmentation_format().create_parser()
    snapshots: list[ImageSegmentationSnapshot] = []
    for chunk in chunks:
        snapshots.extend(parser.push(chunk))
    finished = parser.finish(CompletedOutcome())
    snapshots.extend(finished.events)
    return snapshots, finished.result


def _finish_video(
    chunks: tuple[str, ...],
) -> tuple[list[VideoSegmentationSnapshot], VideoSegmentationResult]:
    parser = video_segmentation_format().create_parser()
    snapshots: list[VideoSegmentationSnapshot] = []
    for chunk in chunks:
        snapshots.extend(parser.push(chunk))
    finished = parser.finish(CompletedOutcome())
    snapshots.extend(finished.events)
    return snapshots, finished.result


def test_public_api_is_root_only_and_complete() -> None:
    assert meta_sam_parser.__all__ == [
        "CompletedOutcome",
        "DiagnosticSeverity",
        "FrameReference",
        "ImageSegmentationResult",
        "ImageSegmentationSnapshot",
        "IncompleteOutcome",
        "IncompleteReason",
        "InvalidSegmentationMaskError",
        "OutputTextLane",
        "ParsedResponsesStream",
        "ParserFinish",
        "RLEObject",
        "ResponseFormat",
        "ResponseFormatParser",
        "ResponseSourceOperation",
        "ResponseStreamOutcome",
        "ResponsesEvent",
        "ResponsesEventLike",
        "ResponsesStreamAbortedError",
        "ResponsesStreamConsumedError",
        "ResponsesStreamError",
        "ResponsesStreamEventError",
        "ResponsesStreamFailedError",
        "ResponsesStreamLaneError",
        "ResponsesStreamParserError",
        "ResponsesStreamRefusalError",
        "ResponsesStreamSourceError",
        "SegmentationBoxRecord",
        "SegmentationDiagnostic",
        "SegmentationMask",
        "SegmentationMaskBounds",
        "SegmentationMaskEncoding",
        "SegmentationMaskIdentity",
        "SegmentationMaskRecord",
        "SegmentationMedia",
        "SegmentationRecord",
        "SegmentationResult",
        "SegmentationSnapshot",
        "SegmentationTextRecord",
        "VideoSegmentationResult",
        "VideoSegmentationSnapshot",
        "decode_mask_to_raster",
        "decode_mask_to_rle",
        "decode_mask_to_svg_path",
        "image_segmentation_format",
        "parse_responses_stream",
        "video_segmentation_format",
    ]
    assert not hasattr(meta_sam_parser, "SegmentationParser")


def test_public_models_are_frozen_slotted_and_collections_are_tuples() -> None:
    identity = SegmentationMaskIdentity("image", None, "shape")
    bounds = SegmentationMaskBounds(0, 0, 5, 5)
    record = SegmentationMaskRecord(
        order=0,
        object_id="shape",
        identity=identity,
        revision=1,
        mask=SegmentationMask("one_bit", _PAYLOAD, 5, 5),
        bounds=bounds,
    )
    diagnostic = SegmentationDiagnostic("error", "test", "message", 1, "raw")
    snapshot = ImageSegmentationSnapshot(1, (record,), (diagnostic,), "raw")
    result = ImageSegmentationResult(
        1, (record,), (diagnostic,), "raw", CompletedOutcome()
    )
    finish = ParserFinish(events=(snapshot,), result=result)

    assert isinstance(snapshot.records, tuple)
    assert isinstance(snapshot.diagnostics, tuple)
    assert isinstance(result, ImageSegmentationSnapshot)
    assert [item.name for item in fields(result)] == [
        "media",
        "revision",
        "records",
        "diagnostics",
        "raw_output",
        "outcome",
    ]
    video_result = VideoSegmentationResult(
        1, (record,), (diagnostic,), "raw", CompletedOutcome()
    )
    assert isinstance(video_result, VideoSegmentationSnapshot)
    assert [item.name for item in fields(video_result)][:-1] == [
        item.name for item in fields(VideoSegmentationSnapshot)
    ]
    assert isinstance(finish.events, tuple)
    for value in (
        identity,
        bounds,
        record,
        diagnostic,
        snapshot,
        result,
        result.outcome,
        finish,
    ):
        assert not hasattr(value, "__dict__")
        assert cast(Any, type(value)).__dataclass_params__.frozen is True


def test_formats_are_reusable_with_isolated_parser_state() -> None:
    format_ = video_segmentation_format()
    line = _line(0, _record())
    first = format_.create_parser()
    second = format_.create_parser()
    first.push(line)
    second.push(line)
    first_result = first.finish(IncompleteOutcome(reason="eof")).result
    second_result = second.finish(IncompleteOutcome(reason="eof")).result

    assert isinstance(first_result, VideoSegmentationResult)
    assert isinstance(second_result, VideoSegmentationResult)
    assert cast(SegmentationMaskRecord, first_result.records[1]).revision == 1
    assert cast(SegmentationMaskRecord, second_result.records[1]).revision == 1
    with pytest.raises((FrozenInstanceError, AttributeError)):
        format_._media = "image"  # type: ignore[attr-defined]


def test_image_records_parse_across_every_character_boundary() -> None:
    text = "Synthetic scene.\n" + _line(0, _record("0"), _record("1", x1=5, x2=9))
    snapshots, result = _finish_image(tuple(text))

    assert [record.kind for record in result.records] == [
        "text",
        "box",
        "mask",
        "box",
        "mask",
    ]
    assert result.diagnostics == ()
    assert result.raw_output == text
    assert result.outcome == CompletedOutcome()
    # One snapshot per completed line: the prose line, then the record line.
    assert [snapshot.revision for snapshot in snapshots] == [1, 2]


def test_push_emits_at_most_one_cumulative_snapshot_per_changing_chunk() -> None:
    parser = image_segmentation_format().create_parser()
    snapshots = parser.push("first\nsecond\n\n")
    assert len(snapshots) == 1
    assert snapshots[0].revision == 1
    assert [
        record.text for record in snapshots[0].records if record.kind == "text"
    ] == [
        "first",
        "second",
    ]
    assert parser.push("\n") == ()
    assert parser.push("third\n", emit=False) == ()
    result = parser.finish(CompletedOutcome()).result
    assert result.revision == 2
    assert len(result.records) == 3


def test_crlf_blank_lines_and_final_unterminated_line_preserve_raw_output() -> None:
    parser = image_segmentation_format().create_parser()
    first = parser.push("abc\r\n\r\n")
    assert len(first) == 1
    assert first[0].records == (SegmentationTextRecord(order=0, text="abc"),)
    assert first[0].raw_output == "abc\r\n\r\n"
    assert parser.push("xy\r") == ()
    finished = parser.finish(IncompleteOutcome(reason="eof"))
    assert finished.events[0].records[-1] == SegmentationTextRecord(order=1, text="xy")
    assert finished.result.outcome == IncompleteOutcome(reason="eof")
    assert finished.result.raw_output == "abc\r\n\r\nxy\r"


def test_crlf_line_limit_is_invariant_across_every_split_point() -> None:
    text = "abc\r\n"
    for split in range(len(text) + 1):
        chunks = tuple(chunk for chunk in (text[:split], text[split:]) if chunk)
        snapshots, result = _finish_image(chunks)
        assert len(snapshots) == 1
        assert result.records == (SegmentationTextRecord(order=0, text="abc"),)


def test_api_coordinates_are_ascii_decimal_integers_only() -> None:
    _, result = _finish_image(
        (
            _line(0, _record(x1=0, x2=4).replace("x1=0", "x1=0x0"))
            + _line(0, _record().replace("y1=0", "y1=.5"))
            + _line(0, _record().replace("x2=4", "x2=1e1"))
            + _line(0, _record(w=20).replace("w=20", "w=1_0")),
        )
    )
    assert result.records == ()
    assert [diagnostic.code for diagnostic in result.diagnostics] == [
        "malformed_record"
    ] * 4


def test_ascii_grammar_and_javascript_whitespace_boundaries() -> None:
    _, result = _finish_video(
        (
            f"<\u0667f>{_record()}\n"  # non-ASCII digit in the frame header
            f"<7f>\u00a0{_record()}\n"  # non-ASCII whitespace before the record
            f"<7f>{_record(payload='!' + chr(0x85))}\n"  # non-ASCII payload byte
            "<\u0660f>x\n",
        )
    )
    assert [record.kind for record in result.records] == ["text", "box", "text"]
    assert cast(SegmentationTextRecord, result.records[0]).text == (
        f"<\u0667f>{_record()}"
    )
    assert cast(SegmentationTextRecord, result.records[2]).text == "<\u0660f>x"
    assert [diagnostic.code for diagnostic in result.diagnostics] == [
        "malformed_record",
        "invalid_mask_payload",
    ]


def test_api_image_records_use_half_open_bounds_and_lossless_masks() -> None:
    line = (
        "<0f>7<|box;x1=0;y1=0;x2=2;y2=1;w=3;h=2|>"
        f"<|mask;x=0;y=0;data=2,3,{_LOSSLESS_PAYLOAD}|>\n"
    )
    _, result = _finish_image((line,))
    box = cast(SegmentationBoxRecord, result.records[0])
    mask = cast(SegmentationMaskRecord, result.records[1])
    assert (box.left, box.top, box.right, box.bottom) == (0, 0, 3, 2)
    assert mask.bounds == SegmentationMaskBounds(0, 0, 3, 2)
    assert mask.frame is None
    assert mask.mask == SegmentationMask("lossless", _LOSSLESS_PAYLOAD, 3, 2)
    assert mask.identity == SegmentationMaskIdentity("image", None, "7")


def test_api_signed_zero_coordinates_normalize_to_zero() -> None:
    line = (
        "<0f>0<|box;x1=-0;y1=-0;x2=4;y2=4;w=5;h=5|>"
        f"<|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>\n"
    )
    _, result = _finish_image((line,))
    box = cast(SegmentationBoxRecord, result.records[0])
    mask = cast(SegmentationMaskRecord, result.records[1])
    assert (box.left, box.top) == (0, 0)
    assert mask.bounds == SegmentationMaskBounds(0, 0, 5, 5)


def test_api_video_line_accepts_multiple_objects() -> None:
    object_1 = (
        f"0<|box;x1=0;y1=0;x2=4;y2=4;w=10;h=10|><|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>"
    )
    object_2 = (
        f",2<|box;x1=5;y1=5;x2=9;y2=9;w=10;h=10|><|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>"
    )
    _, result = _finish_video((f"<7f>{object_1}{object_2}\n",))
    assert [record.kind for record in result.records] == ["box", "mask", "box", "mask"]
    assert all(
        record.kind == "text" or record.frame == FrameReference(7)
        for record in result.records
    )


def test_api_line_accepts_optional_commas_and_numeric_ids() -> None:
    segment = (
        "{object_id}<|box;x1=0;y1=0;x2=4;y2=4;w=5;h=5|>"
        f"<|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>"
    )
    text = f"<0f>,{segment.format(object_id='0')}{segment.format(object_id='2')},"
    text += f"{segment.format(object_id='10')}\n"
    _, result = _finish_image((text,))
    assert [record.kind for record in result.records] == [
        "box",
        "mask",
        "box",
        "mask",
        "box",
        "mask",
    ]
    assert [
        record.object_id
        for record in result.records
        if isinstance(record, SegmentationBoxRecord)
    ] == ["0", "2", "10"]
    assert result.diagnostics == ()


def test_api_malformed_tail_keeps_already_accepted_segments() -> None:
    valid = (
        f"0<|box;x1=0;y1=0;x2=4;y2=4;w=10;h=10|><|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>"
    )
    _, result = _finish_image((f"<0f>{valid},broken\n",))
    assert [record.kind for record in result.records] == ["box", "mask"]
    assert [diagnostic.code for diagnostic in result.diagnostics] == [
        "malformed_record"
    ]


@pytest.mark.parametrize(
    "line,code",
    [
        (
            f"<0f>car<|box;x1=0;y1=0;x2=4;y2=4;w=5;h=5|><|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>",
            "malformed_record",
        ),
        ("<0f>", "malformed_record"),
        ("<1f>", "unexpected_frame"),
        ("<9007199254740992f>", "invalid_frame"),
        (
            f"<0f>0<|box;x1=-1;y1=0;x2=4;y2=4;w=5;h=5|><|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>",
            "invalid_box",
        ),
        (
            f"<0f>0<|box;x1=0;y1=0;x2=5;y2=4;w=5;h=5|><|mask;x=0;y=0;data=5,5,{_PAYLOAD}|>",
            "invalid_box",
        ),
    ],
)
def test_api_frame_and_box_validation(line: str, code: str) -> None:
    _, result = _finish_image((f"{line}\n",))
    assert result.records == ()
    assert [diagnostic.code for diagnostic in result.diagnostics] == [code]


def test_image_frame_zero_is_omitted_from_records() -> None:
    _, result = _finish_image((_line(0, _record()) + _line(1, _record()),))
    assert [record.kind for record in result.records] == ["box", "mask"]
    assert all(
        record.kind == "text" or record.frame is None for record in result.records
    )
    assert [diagnostic.code for diagnostic in result.diagnostics] == [
        "unexpected_frame"
    ]


def test_masks_are_decoded_before_insertion_and_revisioning() -> None:
    bad = _PAYLOAD[:-1]
    _, result = _finish_video(
        (
            _line(7, _record("3", payload=bad))
            + _line(7, _record("3"))
            + _line(7, _record("3"))
            + _line(8, _record("3"))
            + _line(7, _record("4")),
        )
    )
    masks = [
        record
        for record in result.records
        if isinstance(record, SegmentationMaskRecord)
    ]
    assert [mask.revision for mask in masks] == [1, 2, 1, 1]
    assert [mask.identity for mask in masks] == [
        SegmentationMaskIdentity("video", 7, "3"),
        SegmentationMaskIdentity("video", 7, "3"),
        SegmentationMaskIdentity("video", 8, "3"),
        SegmentationMaskIdentity("video", 7, "4"),
    ]
    assert [diagnostic.code for diagnostic in result.diagnostics] == [
        "invalid_mask_payload"
    ]


def test_prose_and_structured_diagnostics_preserve_source_lines() -> None:
    raw = (
        "  Useful prose  \n"
        "<0f>\n"
        + _line(0, _record(x1=3, y1=4, x2=1, y2=2))
        + _line(0, _record(size="1,1", payload="x"))
        + _line(0, _record(payload=_PAYLOAD[:-1]))
        + _line(1, _record())
    )
    _, result = _finish_image((raw,))
    # The box of a record whose mask fails is still an accepted, ordered record.
    assert [record.kind for record in result.records] == ["text", "box"]
    assert result.records[0] == SegmentationTextRecord(0, "  Useful prose  ")
    assert [diagnostic.code for diagnostic in result.diagnostics] == [
        "malformed_record",
        "invalid_box",
        "malformed_record",
        "invalid_mask_payload",
        "unexpected_frame",
    ]
    assert [diagnostic.line for diagnostic in result.diagnostics] == [2, 3, 4, 5, 6]
    assert result.diagnostics[0].raw == "<0f>"


def test_format_factories_reject_all_arguments() -> None:
    with pytest.raises(TypeError):
        image_segmentation_format(object())  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        video_segmentation_format(options=None)  # type: ignore[call-arg]


def test_parser_retains_a_line_beyond_the_former_text_thresholds() -> None:
    chunk = "x" * 4_096
    count = 977
    parser = image_segmentation_format().create_parser()
    for _ in range(count):
        assert parser.push(chunk, emit=False) == ()
    result = parser.finish(CompletedOutcome()).result
    assert len(result.raw_output) == len(chunk) * count
    assert result.records == (SegmentationTextRecord(0, chunk * count),)


def test_parser_retains_records_beyond_the_former_count_threshold() -> None:
    count = 20_001
    _, result = _finish_image(("record\n" * count,))
    assert len(result.records) == count
    assert result.records[-1] == SegmentationTextRecord(count - 1, "record")


def test_parser_retains_diagnostics_beyond_the_former_count_threshold() -> None:
    count = 1_001
    _, result = _finish_image(("<0f>\n" * count,))
    assert result.records == ()
    assert len(result.diagnostics) == count


def test_parser_retains_masks_beyond_the_former_count_threshold() -> None:
    count = 4_097
    line = _line(0, _record())
    _, result = _finish_image((line * count,))
    assert len(result.records) == 2 * count
    last = result.records[-1]
    assert isinstance(last, SegmentationMaskRecord)
    assert last.revision == count
    assert result.diagnostics == ()


def test_parser_reaches_structural_mask_validation_beyond_former_thresholds() -> None:
    _, area = _finish_image(
        (_line(0, _record(x2=16777216, w=16777217, size="1,16777217", payload="!!")),)
    )
    assert [item.code for item in area.diagnostics] == ["invalid_mask_payload"]
    assert "missing its length prefix" in area.diagnostics[0].message

    oversized_payload = "!" * 2_000_001
    _, payload = _finish_image(
        (_line(0, _record(x2=0, y2=0, size="1,1", payload=oversized_payload)),)
    )
    assert [item.code for item in payload.diagnostics] == ["invalid_mask_payload"]
    assert "length does not match its prefix" in payload.diagnostics[0].message


def test_terminal_carriage_return_is_excluded_from_a_line() -> None:
    snapshots, result = _finish_image(("abc\r\n",))
    assert len(snapshots) == 1
    assert result.records == (SegmentationTextRecord(0, "abc"),)


def test_parser_rejects_non_string_chunks_without_changing_state() -> None:
    parser = image_segmentation_format().create_parser()
    with pytest.raises(TypeError, match="Parser chunks must be strings"):
        parser.push(cast(Any, b"text"))
    assert parser.finish(CompletedOutcome()).result.raw_output == ""


def test_invalid_mask_decoder_failure_becomes_a_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(_mask: SegmentationMask) -> bytes:
        raise InvalidSegmentationMaskError("synthetic invalid mask")

    monkeypatch.setattr(segmentation, "decode_mask_to_raster", fail)
    _, result = _finish_image((_line(0, _record()),))
    assert [record.kind for record in result.records] == ["box"]
    assert result.diagnostics[0].code == "invalid_mask_payload"
    assert result.diagnostics[0].message == "synthetic invalid mask"


def test_parser_propagates_decoder_memory_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failure = MemoryError("synthetic allocation failure")

    def fail(_mask: SegmentationMask) -> bytes:
        raise failure

    monkeypatch.setattr(segmentation, "decode_mask_to_raster", fail)
    parser = image_segmentation_format().create_parser()
    with pytest.raises(MemoryError) as raised:
        parser.push(_line(0, _record()))
    assert raised.value is failure


def test_protocol_types_accept_structural_format_implementations() -> None:
    format_: ResponseFormat[ImageSegmentationSnapshot, ImageSegmentationResult] = (
        image_segmentation_format()
    )
    parser: ResponseFormatParser[ImageSegmentationSnapshot, ImageSegmentationResult] = (
        format_.create_parser()
    )
    assert parser.finish(CompletedOutcome()).result.media == "image"
