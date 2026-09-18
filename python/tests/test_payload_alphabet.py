# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import pathlib

from meta_sam_parser import _mask_codec as codec

# The documented base85 digits: printable ASCII from ``!`` through ``{`` minus the
# seven wire delimiters. protocol/sam3.md quotes this string verbatim; ``}`` and
# ``~`` are never digits, and ``~`` is only the lossless marker.
_DOCUMENTED_DIGITS = (
    "!#$%&'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`"
    "abcdefghijklmnopqrstuvwxyz{"
)
_WIRE_DELIMITERS = ('"', "\\", ",", ";", "<", ">", "|")
_ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_documented_digits_are_printable_ascii_minus_wire_delimiters() -> None:
    assert len(_DOCUMENTED_DIGITS) == 85
    expected = "".join(
        chr(code) for code in range(0x21, 0x7C) if chr(code) not in _WIRE_DELIMITERS
    )
    assert expected == _DOCUMENTED_DIGITS


def test_codec_digit_table_matches_the_documented_digits() -> None:
    # The codec indexes an 87-character table but only the first 85 are digits.
    assert codec._RADIX == 85
    assert codec._ALPHABET[: codec._RADIX] == _DOCUMENTED_DIGITS
    assert codec._ALPHABET[codec._RADIX :] == "}~"
    for character in (*_WIRE_DELIMITERS, "}", "~", " "):
        value = codec._CHARACTER_VALUES[ord(character)]
        assert value < 0 or value >= codec._RADIX


def test_protocol_quotes_the_digits_and_readmes_name_base85() -> None:
    protocol = (_ROOT / "protocol" / "sam3.md").read_text(encoding="utf-8")
    assert f"\n{_DOCUMENTED_DIGITS}\n" in protocol
    for relative in (
        "python/README.md",
        "typescript/packages/parser/README.md",
        "typescript/packages/graphics/README.md",
    ):
        assert "base85" in (_ROOT / relative).read_text(encoding="utf-8"), relative
