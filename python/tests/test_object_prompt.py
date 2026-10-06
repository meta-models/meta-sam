# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import pathlib

import pytest

from meta_sam_parser import (
    CompletedOutcome,
    FramePrompt,
    ObjectPromptError,
    PromptBox,
    PromptObject,
    PromptPoint,
    SegmentationBoxRecord,
    build_object_prompt,
    image_segmentation_format,
)

_README_TEXT = (
    "<30f>1<|box;x1=10;y1=20;x2=39;y2=59;w=640;h=480|><120f>1<|point;x=20;y=40;w=640;h=480|>"
    "-<|point;x=30;y=50;w=640;h=480|>,2<|box;x1=5;y1=5;x2=29;y2=29;w=640;h=480|>"
)


def test_a_parsed_box_record_and_its_object_id_prompt_the_same_box() -> None:
    box = "<|box;x1=3;y1=4;x2=7;y2=8;w=20;h=10|>"
    parser = image_segmentation_format().create_parser()
    parser.push(f"<0f>4{box}<|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n")
    result = parser.finish(CompletedOutcome()).result
    record = next(r for r in result.records if isinstance(r, SegmentationBoxRecord))
    text = build_object_prompt(
        size=(20, 10),
        objects=[PromptObject(id=record.object_id, prompts=[FramePrompt(box=record)])],
    )
    assert text == f"<0f>4{box}"


def test_the_readme_example_builds_the_documented_text() -> None:
    text = build_object_prompt(
        size=(640, 480),
        objects=[
            PromptObject(
                id=1,
                prompts=[
                    FramePrompt(frame=30, box=PromptBox(10, 20, 40, 60)),
                    FramePrompt(
                        frame=120,
                        points=[
                            PromptPoint(20, 40),
                            PromptPoint(30, 50, label="negative"),
                        ],
                    ),
                ],
            ),
            PromptObject(
                id=2, prompts=[FramePrompt(frame=120, box=PromptBox(5, 5, 30, 30))]
            ),
        ],
    )
    assert text == _README_TEXT
    readme = (pathlib.Path(__file__).resolve().parents[1] / "README.md").read_text(
        encoding="utf-8"
    )
    split = _README_TEXT.index("-<|point")
    assert "# " + _README_TEXT[:split] in readme
    assert "# " + _README_TEXT[split:] in readme


def test_errors_carry_their_code() -> None:
    with pytest.raises(ObjectPromptError) as raised:
        build_object_prompt(size=(640, 480), objects=[])
    assert raised.value.code == "no_objects"
    assert isinstance(raised.value, ValueError)


def test_booleans_are_not_integers() -> None:
    with pytest.raises(ObjectPromptError) as raised:
        build_object_prompt(
            size=(640, 480),
            objects=[
                PromptObject(id=True, prompts=[FramePrompt(points=[PromptPoint(1, 1)])])
            ],
        )
    assert raised.value.code == "invalid_object_id"
