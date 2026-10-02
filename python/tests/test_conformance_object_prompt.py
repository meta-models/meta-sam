# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from meta_sam_parser import (
    FramePrompt,
    ObjectPromptError,
    PromptBox,
    PromptObject,
    PromptPoint,
    build_object_prompt,
)

_ROOT = Path(__file__).resolve().parents[2] / "conformance"
_DIRECTORY = _ROOT / "object-prompts"
_SCHEMA = json.loads((_ROOT / "object-prompt.schema.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(_SCHEMA)
_VALIDATOR = Draft202012Validator(_SCHEMA)


def _load_cases() -> list[dict[str, Any]]:
    unsupported = [
        entry.name
        for entry in _DIRECTORY.iterdir()
        if not entry.is_file() or entry.suffix != ".json"
    ]
    assert not unsupported, f"unsupported object-prompt entries: {unsupported}"
    cases = []
    for path in sorted(_DIRECTORY.glob("*.json")):
        case = json.loads(path.read_text(encoding="utf-8"))
        errors = sorted(_VALIDATOR.iter_errors(case), key=str)
        assert not errors, f"{path.name} failed schema validation: {errors[0].message}"
        assert f"{case['name']}.json" == path.name, f"{path.name} must match its name"
        cases.append(case)
    return cases


_CASES = _load_cases()


def _native_objects(objects: list[dict[str, Any]]) -> list[PromptObject]:
    return [
        PromptObject(
            id=item["id"],
            prompts=[
                FramePrompt(
                    frame=prompt.get("frame", 0),
                    box=PromptBox(**prompt["box"]) if "box" in prompt else None,
                    points=[PromptPoint(**point) for point in prompt.get("points", [])],
                )
                for prompt in item["prompts"]
            ],
        )
        for item in objects
    ]


@pytest.mark.conformance
def test_discovers_the_complete_shared_object_prompt_corpus() -> None:
    assert len(_CASES) == 22


@pytest.mark.conformance
@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_shared_object_prompt(case: dict[str, Any]) -> None:
    size = (case["input"]["size"]["width"], case["input"]["size"]["height"])
    objects = _native_objects(case["input"]["objects"])
    expected = case["expected"]
    if "text" in expected:
        assert build_object_prompt(size=size, objects=objects) == expected["text"]
        return
    with pytest.raises(ObjectPromptError) as raised:
        build_object_prompt(size=size, objects=objects)
    assert raised.value.code == expected["error"]
