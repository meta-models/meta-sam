# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, cast

import pytest

from meta_sam_parser import (
    CompletedOutcome,
    IncompleteOutcome,
    InvalidSegmentationMaskError,
    OutputTextLane,
    ParsedResponsesStream,
    ParserFinish,
    ResponseFormat,
    ResponseFormatParser,
    ResponsesEventLike,
    ResponsesStreamAbortedError,
    ResponsesStreamConsumedError,
    ResponsesStreamError,
    ResponsesStreamEventError,
    ResponsesStreamFailedError,
    ResponsesStreamLaneError,
    ResponsesStreamParserError,
    ResponsesStreamRefusalError,
    ResponsesStreamSourceError,
    parse_responses_stream,
    video_segmentation_format,
)

Event = dict[str, object]


@dataclass(frozen=True, slots=True)
class TextResult:
    text: str
    outcome: CompletedOutcome | IncompleteOutcome


class TextParser(ResponseFormatParser[str, TextResult]):
    def __init__(
        self,
        *,
        emits: list[bool] | None = None,
        push_failure: BaseException | None = None,
        finish_failure: BaseException | None = None,
    ) -> None:
        self.text = ""
        self.emits = emits
        self.push_failure = push_failure
        self.finish_failure = finish_failure

    def push(self, chunk: str, *, emit: bool = True) -> tuple[str, ...]:
        if self.push_failure is not None:
            raise self.push_failure
        self.text += chunk
        if self.emits is not None:
            self.emits.append(emit)
        return (chunk,) if emit else ()

    def finish(
        self, outcome: CompletedOutcome | IncompleteOutcome
    ) -> ParserFinish[str, TextResult]:
        if self.finish_failure is not None:
            raise self.finish_failure
        return ParserFinish(events=(), result=TextResult(self.text, outcome))


class TextFormat(ResponseFormat[str, TextResult]):
    def __init__(
        self,
        *,
        emits: list[bool] | None = None,
        create_failure: BaseException | None = None,
        push_failure: BaseException | None = None,
        finish_failure: BaseException | None = None,
    ) -> None:
        self.emits = emits
        self.create_failure = create_failure
        self.push_failure = push_failure
        self.finish_failure = finish_failure

    def create_parser(self) -> ResponseFormatParser[str, TextResult]:
        if self.create_failure is not None:
            raise self.create_failure
        return TextParser(
            emits=self.emits,
            push_failure=self.push_failure,
            finish_failure=self.finish_failure,
        )


def _lane(
    event_type: str,
    *,
    item_id: object = "message-1",
    output_index: object = 0,
    content_index: object = 0,
    **fields: object,
) -> Event:
    return {
        "type": event_type,
        "item_id": item_id,
        "output_index": output_index,
        "content_index": content_index,
        **fields,
    }


def _delta(text: str, **lane: object) -> Event:
    return _lane("response.output_text.delta", delta=text, **lane)


def _done(text: str, **lane: object) -> Event:
    return _lane("response.output_text.done", text=text, **lane)


def _content_part_done(
    part_type: str,
    *,
    item_id: object = "message-1",
    output_index: object = 0,
    content_index: object = 0,
    **part_fields: object,
) -> Event:
    return _lane(
        "response.content_part.done",
        item_id=item_id,
        output_index=output_index,
        content_index=content_index,
        part={"type": part_type, **part_fields},
    )


async def _events(*values: ResponsesEventLike) -> AsyncIterator[ResponsesEventLike]:
    for value in values:
        yield value


class TrackedIterator(AsyncIterator[ResponsesEventLike]):
    def __init__(
        self,
        values: list[ResponsesEventLike],
        counts: dict[str, int],
        *,
        next_failure: BaseException | None = None,
        close_failure: BaseException | None = None,
        close_callback: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.values = values
        self.counts = counts
        self.next_failure = next_failure
        self.close_failure = close_failure
        self.close_callback = close_callback
        self.index = 0

    async def __anext__(self) -> ResponsesEventLike:
        self.counts["next"] += 1
        if self.next_failure is not None:
            raise self.next_failure
        if self.index == len(self.values):
            raise StopAsyncIteration
        value = self.values[self.index]
        self.index += 1
        return value

    async def aclose(self) -> None:
        self.counts["close"] += 1
        if self.close_callback is not None:
            await self.close_callback()
        if self.close_failure is not None:
            raise self.close_failure


class TrackedSource(AsyncIterable[ResponsesEventLike]):
    def __init__(
        self,
        values: list[ResponsesEventLike],
        *,
        next_failure: BaseException | None = None,
        close_failure: BaseException | None = None,
        close_callback: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.values = values
        self.next_failure = next_failure
        self.close_failure = close_failure
        self.close_callback = close_callback
        self.counts = {"iterator": 0, "next": 0, "close": 0}

    def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
        self.counts["iterator"] += 1
        return TrackedIterator(
            self.values,
            self.counts,
            next_failure=self.next_failure,
            close_failure=self.close_failure,
            close_callback=self.close_callback,
        )


class SourceOwnedClose(AsyncIterable[ResponsesEventLike]):
    def __init__(self, values: list[ResponsesEventLike]) -> None:
        self.counts = {"iterator": 0, "next": 0, "close": 0}
        self.source_close_count = 0
        self._iterator = TrackedIterator(values, self.counts)

    async def _iterate(self) -> AsyncIterator[ResponsesEventLike]:
        async for value in self._iterator:
            yield value

    def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
        self.counts["iterator"] += 1
        return self._iterate()

    async def close(self) -> None:
        self.source_close_count += 1
        await self._iterator.aclose()


async def _capture(awaitable: Awaitable[object]) -> BaseException:
    try:
        await awaitable
    except BaseException as error:
        return error
    raise AssertionError("Expected awaitable to fail")


def test_iteration_first_is_lazy_and_reuses_the_final_result() -> None:
    async def run() -> None:
        source = TrackedSource(
            [_delta("a"), _delta("b"), _done("ab"), {"type": "response.completed"}]
        )
        parsed = parse_responses_stream(source, TextFormat())
        assert source.counts == {"iterator": 0, "next": 0, "close": 0}
        iterator = aiter(parsed)
        assert source.counts == {"iterator": 0, "next": 0, "close": 0}
        final_one = asyncio.ensure_future(parsed.final_result())
        final_two = asyncio.ensure_future(parsed.final_result())
        assert await anext(iterator) == "a"
        assert await anext(iterator) == "b"
        with pytest.raises(StopAsyncIteration):
            await anext(iterator)
        result_one, result_two = await asyncio.gather(final_one, final_two)
        assert result_one is result_two
        assert result_one == TextResult("ab", CompletedOutcome())
        assert source.counts == {"iterator": 1, "next": 4, "close": 1}
        with pytest.raises(ResponsesStreamConsumedError):
            aiter(parsed)

    asyncio.run(run())


def test_final_result_first_drains_once_and_suppresses_events() -> None:
    async def run() -> None:
        emits: list[bool] = []
        source = TrackedSource(
            [_delta("a"), _delta("b"), _done("ab"), {"type": "response.completed"}]
        )
        parsed = parse_responses_stream(source, TextFormat(emits=emits))
        first, second = await asyncio.gather(
            parsed.final_result(), parsed.final_result()
        )
        assert first is second
        assert first == TextResult("ab", CompletedOutcome())
        assert emits == [False, False]
        assert source.counts == {"iterator": 1, "next": 4, "close": 1}
        with pytest.raises(ResponsesStreamConsumedError):
            aiter(parsed)

    asyncio.run(run())


def test_final_result_claims_final_only_mode_before_awaiting() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(_done("done"), {"type": "response.completed"}), TextFormat()
        )
        final = parsed.final_result()
        with pytest.raises(ResponsesStreamConsumedError):
            aiter(parsed)
        assert await final == TextResult("done", CompletedOutcome())

    asyncio.run(run())


def test_final_result_waits_until_terminal_iterator_events_are_observed() -> None:
    class TerminalEventParser(TextParser):
        def push(self, chunk: str, *, emit: bool = True) -> tuple[str, ...]:
            self.text += chunk
            return ()

        def finish(
            self, outcome: CompletedOutcome | IncompleteOutcome
        ) -> ParserFinish[str, TextResult]:
            return ParserFinish(
                events=("terminal",), result=TextResult(self.text, outcome)
            )

    class TerminalEventFormat(ResponseFormat[str, TextResult]):
        def create_parser(self) -> ResponseFormatParser[str, TextResult]:
            return TerminalEventParser()

    async def run() -> None:
        parsed = parse_responses_stream(
            _events(_done("done"), {"type": "response.completed"}),
            TerminalEventFormat(),
        )
        iterator = aiter(parsed)
        final = asyncio.ensure_future(parsed.final_result())
        assert await anext(iterator) == "terminal"
        assert not final.done()
        with pytest.raises(StopAsyncIteration):
            await anext(iterator)
        assert await final == TextResult("done", CompletedOutcome())

    asyncio.run(run())


def test_direct_pull_and_conflicting_consumers_are_rejected() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_events(), TextFormat())
        with pytest.raises(ResponsesStreamConsumedError):
            await anext(parsed)

        claimed = parse_responses_stream(_events(), TextFormat())
        assert aiter(claimed) is claimed
        with pytest.raises(ResponsesStreamConsumedError):
            aiter(claimed)

        final_only = parse_responses_stream(_events(), TextFormat())
        await final_only.final_result()
        with pytest.raises(ResponsesStreamConsumedError):
            aiter(final_only)

    asyncio.run(run())


def test_concurrent_pulls_are_serialized() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                _delta("first"),
                _delta("second"),
                _done("firstsecond"),
                {"type": "response.completed"},
            ),
            TextFormat(),
        )
        iterator = aiter(parsed)
        first = asyncio.create_task(anext(iterator))
        second = asyncio.create_task(anext(iterator))
        results = await asyncio.gather(first, second)
        assert list(results) == ["first", "second"]
        with pytest.raises(StopAsyncIteration):
            await anext(iterator)
        assert await parsed.final_result() == TextResult(
            "firstsecond", CompletedOutcome()
        )

    asyncio.run(run())


def test_async_context_exit_aborts_and_closes_once() -> None:
    async def run() -> None:
        source = TrackedSource([_delta("first"), _delta("second")])
        parsed = parse_responses_stream(source, TextFormat())
        async with parsed:
            async for value in parsed:
                assert value == "first"
                break
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamAbortedError)
        assert source.counts["close"] == 1
        await parsed.aclose()
        assert source.counts["close"] == 1

    asyncio.run(run())


def test_source_owned_close_runs_for_wrapped_iterators() -> None:
    async def run() -> None:
        source = SourceOwnedClose([_done("done"), {"type": "response.completed"}])
        parsed = parse_responses_stream(source, TextFormat())
        assert await parsed.final_result() == TextResult("done", CompletedOutcome())
        assert source.source_close_count == 1
        assert source.counts == {"iterator": 1, "next": 2, "close": 1}

    asyncio.run(run())


def test_terminal_finish_snapshot_still_requires_iterator_completion() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                _done("unterminated"),
                {"type": "response.completed"},
            ),
            video_segmentation_format(),
        )
        async with parsed:
            async for snapshot in parsed:
                assert snapshot.raw_output == "unterminated"
                break
        assert isinstance(
            await _capture(parsed.final_result()), ResponsesStreamAbortedError
        )

    asyncio.run(run())


def test_async_context_preserves_completed_result() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(_done("done"), {"type": "response.completed"}), TextFormat()
        )
        async with parsed:
            assert [value async for value in parsed] == ["done"]
        assert await parsed.final_result() == TextResult("done", CompletedOutcome())

    asyncio.run(run())


def test_explicit_close_before_consumption_is_lazy_and_aborted() -> None:
    async def run() -> None:
        source = TrackedSource([_delta("unused")])
        parsed = parse_responses_stream(source, TextFormat())
        await parsed.aclose()
        assert source.counts == {"iterator": 0, "next": 0, "close": 0}
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamAbortedError)
        with pytest.raises(ResponsesStreamConsumedError):
            aiter(parsed)

    asyncio.run(run())


def test_unstarted_source_owner_closes_once_for_sync_and_async_close() -> None:
    class SyncClosableSource(AsyncIterable[ResponsesEventLike]):
        def __init__(self) -> None:
            self.iterator_calls = 0
            self.close_count = 0

        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            self.iterator_calls += 1
            return _events()

        def close(self) -> None:
            self.close_count += 1

    class AsyncClosableSource(SyncClosableSource):
        async def aclose(self) -> None:
            self.close_count += 1

    async def run() -> None:
        for source in (SyncClosableSource(), AsyncClosableSource()):
            parsed = parse_responses_stream(source, TextFormat())
            await parsed.aclose()
            assert source.iterator_calls == 0
            assert source.close_count == 1
            assert isinstance(
                await _capture(parsed.final_result()), ResponsesStreamAbortedError
            )
            await parsed.aclose()
            assert source.close_count == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    "values,expected",
    [
        ([_delta("truncated")], TextResult("truncated", IncompleteOutcome("eof"))),
        (
            [
                _delta("partial"),
                _done("partial"),
                {
                    "type": "response.incomplete",
                    "response": {"incomplete_details": {"reason": "max_output"}},
                },
            ],
            TextResult("partial", IncompleteOutcome("response", detail="max_output")),
        ),
        (
            [_done("fallback"), {"type": "response.completed"}],
            TextResult("fallback", CompletedOutcome()),
        ),
    ],
)
def test_terminal_outcomes_and_done_only_fallback(
    values: list[ResponsesEventLike], expected: TextResult
) -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_events(*values), TextFormat())
        assert await parsed.final_result() == expected

    asyncio.run(run())


@pytest.mark.parametrize(
    "finalizers",
    [
        (
            _done("same text"),
            _content_part_done("output_text", text="same text"),
        ),
        (
            _content_part_done("output_text", text="same text"),
            _done("same text"),
        ),
    ],
)
def test_output_text_and_content_part_done_with_identical_text_are_idempotent(
    finalizers: tuple[Event, Event],
) -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(*finalizers, {"type": "response.completed"}), TextFormat()
        )
        assert await parsed.final_result() == TextResult(
            "same text", CompletedOutcome()
        )

    asyncio.run(run())


def test_content_part_done_supplies_text_without_deltas() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                _content_part_done("output_text", text="whole input"),
                {"type": "response.completed"},
            ),
            TextFormat(),
        )
        assert await parsed.final_result() == TextResult(
            "whole input", CompletedOutcome()
        )

    asyncio.run(run())


def test_content_part_done_conflicting_text_is_lane_error() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                _delta("accumulated"),
                _content_part_done("output_text", text="different"),
            ),
            TextFormat(),
        )
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamLaneError)
        assert str(error) == (
            "The finalized output text conflicts with its accumulated deltas."
        )

    asyncio.run(run())


def test_content_part_done_on_different_lane_is_lane_error() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                _delta("text"),
                _content_part_done(
                    "output_text",
                    item_id="message-2",
                    output_index=1,
                    text="text",
                ),
            ),
            TextFormat(),
        )
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamLaneError)
        assert error.expected == OutputTextLane("message-1", 0, 0)
        assert error.received == OutputTextLane("message-2", 1, 0)

    asyncio.run(run())


def test_second_cross_event_finalization_with_different_text_is_lane_error() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                _done("first"),
                _content_part_done("output_text", text="second"),
            ),
            TextFormat(),
        )
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamLaneError)
        assert str(error) == (
            "The response finalized its output text lane twice with conflicting text."
        )

    asyncio.run(run())


def test_content_part_done_refusal_is_typed_failure() -> None:
    async def run() -> None:
        event = _content_part_done("refusal", refusal="cannot comply")
        parsed = parse_responses_stream(_events(event), TextFormat())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamRefusalError)
        assert str(error) == "cannot comply"
        assert error.event is event

    asyncio.run(run())


def test_reasoning_content_part_done_does_not_finalize_output_text_lane() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                _content_part_done("reasoning_text", text="internal reasoning"),
                {"type": "response.completed"},
            ),
            TextFormat(),
        )
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamLaneError)
        assert str(error) == (
            "The response completed before finalizing one output text lane."
        )

    asyncio.run(run())


@pytest.mark.parametrize(
    "values,message",
    [
        (
            [_delta("partial"), _done("different")],
            "The finalized output text conflicts with its accumulated deltas.",
        ),
        (
            [_done("done"), _done("done")],
            "The response finalized its output text lane more than once.",
        ),
        (
            [_done("done"), _delta("late")],
            "The response emitted output text after finalizing its lane.",
        ),
        (
            [{"type": "response.completed"}],
            "The response completed before finalizing one output text lane.",
        ),
        (
            [{"type": "response.incomplete", "response": {}}],
            "The response became incomplete before finalizing one output text lane.",
        ),
    ],
)
def test_lane_finalization_failures(
    values: list[ResponsesEventLike], message: str
) -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_events(*values), TextFormat())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamLaneError)
        assert str(error) == message

    asyncio.run(run())


@pytest.mark.parametrize(
    "lane_fields",
    [
        {"item_id": "", "output_index": 0, "content_index": 0},
        {"item_id": "x", "output_index": -1, "content_index": 0},
        {"item_id": "x", "output_index": True, "content_index": 0},
        {"item_id": "x", "output_index": 1 << 53, "content_index": 0},
        {"item_id": "x", "output_index": 0, "content_index": float("nan")},
        {"item_id": "x", "output_index": 0, "content_index": "0"},
    ],
)
def test_lane_identity_requires_nonempty_id_and_safe_nonnegative_indexes(
    lane_fields: dict[str, object],
) -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(_delta("x", **lane_fields)), TextFormat()
        )
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamLaneError)
        assert error.expected is None
        assert error.received is None

    asyncio.run(run())


def test_integral_float_lanes_are_normalized_and_interleaving_is_fatal() -> None:
    async def run() -> None:
        accepted = parse_responses_stream(
            _events(
                _delta("x", output_index=0.0, content_index=1.0),
                _done("x", output_index=0, content_index=1),
                {"type": "response.completed"},
            ),
            TextFormat(),
        )
        assert await accepted.final_result() == TextResult("x", CompletedOutcome())

        interleaved = parse_responses_stream(
            _events(
                _delta("a"),
                _delta("b", item_id="message-2", output_index=1),
            ),
            TextFormat(),
        )
        error = await _capture(interleaved.final_result())
        assert isinstance(error, ResponsesStreamLaneError)
        assert error.expected == OutputTextLane("message-1", 0, 0)
        assert error.received == OutputTextLane("message-2", 1, 0)

    asyncio.run(run())


def test_missing_delta_and_done_text_are_lane_errors() -> None:
    async def run() -> None:
        for event, message in (
            (
                _lane("response.output_text.delta"),
                "The output text delta is missing its text.",
            ),
            (
                _lane("response.output_text.done"),
                "The completed output text is missing its text.",
            ),
        ):
            parsed = parse_responses_stream(_events(event), TextFormat())
            error = await _capture(parsed.final_result())
            assert isinstance(error, ResponsesStreamLaneError)
            assert str(error) == message

    asyncio.run(run())


@pytest.mark.parametrize(
    "event",
    [
        _lane("response.refusal.delta", delta="cannot comply"),
        _lane("response.refusal.done", refusal="cannot comply"),
        _lane(
            "response.refusal.done",
            item_id="other",
            output_index=2,
            content_index=9,
            refusal="cannot comply",
        ),
        _lane("response.refusal.done"),
    ],
)
def test_refusal_on_any_lane_is_a_typed_failure(event: ResponsesEventLike) -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_events(_delta("partial"), event), TextFormat())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamRefusalError)
        expected = (
            "cannot comply"
            if _field_for_test(event, "refusal", "delta")
            else ("The response was refused.")
        )
        assert str(error) == expected
        assert error.event is event

    asyncio.run(run())


def _field_for_test(event: ResponsesEventLike, *names: str) -> str | None:
    if not isinstance(event, dict):
        return None
    for name in names:
        value = event.get(name)
        if isinstance(value, str):
            return value
    return None


@pytest.mark.parametrize(
    "event,error_type,message",
    [
        (
            {
                "type": "response.failed",
                "response": {"error": {"message": "failed"}},
            },
            ResponsesStreamFailedError,
            "failed",
        ),
        (
            {
                "type": "response.failed",
                "response": {"error": {"message": ""}},
            },
            ResponsesStreamFailedError,
            "",
        ),
        (
            {"type": "response.failed", "response": {}},
            ResponsesStreamFailedError,
            "The response failed.",
        ),
        (
            {"type": "error", "error": {"message": "nested"}},
            ResponsesStreamEventError,
            "nested",
        ),
        (
            {"type": "error", "error": {"message": ""}, "message": "direct"},
            ResponsesStreamEventError,
            "",
        ),
        (
            {"type": "error", "message": ""},
            ResponsesStreamEventError,
            "",
        ),
        (
            {"type": "error", "message": "direct"},
            ResponsesStreamEventError,
            "direct",
        ),
        (
            {"type": "error"},
            ResponsesStreamEventError,
            "The Responses stream reported an error.",
        ),
    ],
)
def test_terminal_error_event_mapping(
    event: ResponsesEventLike,
    error_type: type[ResponsesStreamError],
    message: str,
) -> None:
    async def run() -> None:
        parsed = parse_responses_stream(_events(event), TextFormat())
        first = await _capture(parsed.final_result())
        second = await _capture(parsed.final_result())
        assert isinstance(first, error_type)
        assert first is second
        assert str(first) == message
        assert cast(Any, first).event is event

    asyncio.run(run())


def test_unrelated_events_are_ignored() -> None:
    async def run() -> None:
        parsed = parse_responses_stream(
            _events(
                {"type": "response.created", "response": object()},
                _delta("x"),
                {"type": "response.output_item.added"},
                _done("x"),
                {"type": "response.completed"},
            ),
            TextFormat(),
        )
        assert await parsed.final_result() == TextResult("x", CompletedOutcome())

    asyncio.run(run())


@pytest.mark.parametrize("phase", ["create", "push", "finish"])
def test_parser_failures_are_wrapped_with_cause_and_close_once(phase: str) -> None:
    async def run() -> None:
        cause = RuntimeError(f"{phase} failed")
        source = TrackedSource(
            [_delta("x"), _done("x"), {"type": "response.completed"}]
        )
        format_ = TextFormat(
            create_failure=cause if phase == "create" else None,
            push_failure=cause if phase == "push" else None,
            finish_failure=cause if phase == "finish" else None,
        )
        parsed = parse_responses_stream(source, format_)
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamParserError)
        assert error.code == "parser_error"
        assert error.cause is cause
        assert error.__cause__ is cause
        assert source.counts["close"] == 1

    asyncio.run(run())


def test_package_parser_error_is_not_double_wrapped() -> None:
    async def run() -> None:
        cause = InvalidSegmentationMaskError("invalid")
        parsed = parse_responses_stream(
            _events(_delta("x")), TextFormat(push_failure=cause)
        )
        error = await _capture(parsed.final_result())
        assert error is cause

    asyncio.run(run())


def test_source_iterator_failure_is_wrapped() -> None:
    class BrokenSource(AsyncIterable[ResponsesEventLike]):
        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            raise RuntimeError("iterator failed")

    async def run() -> None:
        parsed = parse_responses_stream(BrokenSource(), TextFormat())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamSourceError)
        assert error.operation == "iterator"
        assert isinstance(error.cause, RuntimeError)
        assert error.prior_error is None

    asyncio.run(run())


def test_source_next_failure_and_invalid_event_are_wrapped_and_closed() -> None:
    async def run() -> None:
        cause = RuntimeError("next failed")
        source = TrackedSource([], next_failure=cause)
        parsed = parse_responses_stream(source, TextFormat())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamSourceError)
        assert error.operation == "next"
        assert error.cause is cause
        assert source.counts["close"] == 1

        invalid = TrackedSource([cast(ResponsesEventLike, object())])
        invalid_parsed = parse_responses_stream(invalid, TextFormat())
        invalid_error = await _capture(invalid_parsed.final_result())
        assert isinstance(invalid_error, ResponsesStreamSourceError)
        assert invalid_error.operation == "next"
        assert isinstance(invalid_error.cause, TypeError)
        assert invalid.counts["close"] == 1

    asyncio.run(run())


def test_synchronous_stop_iteration_is_eof() -> None:
    class SyncStopIterator(AsyncIterator[ResponsesEventLike]):
        def __anext__(self) -> Awaitable[ResponsesEventLike]:
            raise StopAsyncIteration

    class SyncStopSource(AsyncIterable[ResponsesEventLike]):
        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            return SyncStopIterator()

    async def run() -> None:
        parsed = parse_responses_stream(SyncStopSource(), TextFormat())
        assert await parsed.final_result() == TextResult(
            "", IncompleteOutcome(reason="eof")
        )

    asyncio.run(run())


def test_invalid_source_iterator_is_an_iterator_failure() -> None:
    class InvalidSource:
        def __aiter__(self) -> object:
            return object()

    async def run() -> None:
        parsed = parse_responses_stream(
            cast(AsyncIterable[ResponsesEventLike], InvalidSource()), TextFormat()
        )
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamSourceError)
        assert error.operation == "iterator"
        assert isinstance(error.cause, TypeError)

    asyncio.run(run())


def test_throwing_event_type_accessor_is_a_next_failure() -> None:
    cause = RuntimeError("type failed")

    class BrokenEvent:
        @property
        def type(self) -> str:
            raise cause

    async def source() -> AsyncIterator[ResponsesEventLike]:
        yield cast(ResponsesEventLike, BrokenEvent())

    async def run() -> None:
        parsed = parse_responses_stream(source(), TextFormat())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamSourceError)
        assert error.operation == "next"
        assert error.cause is cause

    asyncio.run(run())


def test_close_failure_without_prior_error_is_stable() -> None:
    async def run() -> None:
        cause = RuntimeError("close failed")
        source = TrackedSource(
            [_done("done"), {"type": "response.completed"}], close_failure=cause
        )
        parsed = parse_responses_stream(source, TextFormat())
        first = await _capture(parsed.final_result())
        second = await _capture(parsed.final_result())
        assert first is second
        assert isinstance(first, ResponsesStreamSourceError)
        assert first.operation == "return"
        assert first.cause is cause
        assert first.prior_error is None
        assert source.counts["close"] == 1

    asyncio.run(run())


def test_close_failure_preserves_the_prior_stream_error() -> None:
    async def run() -> None:
        cause = RuntimeError("close failed")
        source = TrackedSource(
            [{"type": "error", "message": "event failed"}], close_failure=cause
        )
        parsed = parse_responses_stream(source, TextFormat())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamSourceError)
        assert error.operation == "return"
        assert error.cause is cause
        assert isinstance(error.prior_error, ResponsesStreamEventError)
        assert source.counts["close"] == 1

    asyncio.run(run())


def test_explicit_close_failure_has_aborted_prior_error() -> None:
    async def run() -> None:
        cause = RuntimeError("close failed")
        source = TrackedSource([_delta("x")], close_failure=cause)
        parsed = parse_responses_stream(source, TextFormat())
        iterator = aiter(parsed)
        assert await anext(iterator) == "x"
        with pytest.raises(ResponsesStreamSourceError) as raised:
            await parsed.aclose()
        assert raised.value.cause is cause
        assert isinstance(raised.value.prior_error, ResponsesStreamAbortedError)
        final_error = await _capture(parsed.final_result())
        assert final_error is raised.value
        assert source.counts["close"] == 1

    asyncio.run(run())


def test_synchronous_close_is_supported_and_throwing_accessors_are_errors() -> None:
    class NonAwaitableCloseIterator(TrackedIterator):
        def aclose(self) -> None:  # type: ignore[override]
            self.counts["close"] += 1

    class NonAwaitableCloseSource(TrackedSource):
        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            self.counts["iterator"] += 1
            return NonAwaitableCloseIterator(self.values, self.counts)

    accessor_cause = RuntimeError("close accessor failed")

    class ThrowingCloseIterator(AsyncIterator[ResponsesEventLike]):
        async def __anext__(self) -> ResponsesEventLike:
            return _delta("x")

        @property
        def aclose(self) -> Callable[[], Awaitable[None]]:
            raise accessor_cause

    class ThrowingCloseSource(AsyncIterable[ResponsesEventLike]):
        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            return ThrowingCloseIterator()

    async def run() -> None:
        non_awaitable = NonAwaitableCloseSource([_delta("x")])
        parsed = parse_responses_stream(non_awaitable, TextFormat())
        iterator = aiter(parsed)
        await anext(iterator)
        await parsed.aclose()
        assert non_awaitable.counts["close"] == 1
        assert isinstance(
            await _capture(parsed.final_result()), ResponsesStreamAbortedError
        )

        throwing = parse_responses_stream(ThrowingCloseSource(), TextFormat())
        throwing_iterator = aiter(throwing)
        await anext(throwing_iterator)
        accessor_error = await _capture(throwing.aclose())
        assert isinstance(accessor_error, ResponsesStreamSourceError)
        assert accessor_error.cause is accessor_cause

    asyncio.run(run())


def test_source_without_aclose_completes_normally() -> None:
    class IteratorWithoutClose(AsyncIterator[ResponsesEventLike]):
        def __init__(self) -> None:
            self.values = iter([_done("x"), {"type": "response.completed"}])

        async def __anext__(self) -> ResponsesEventLike:
            try:
                return cast(ResponsesEventLike, next(self.values))
            except StopIteration:
                raise StopAsyncIteration from None

    class SourceWithoutClose(AsyncIterable[ResponsesEventLike]):
        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            return IteratorWithoutClose()

    async def run() -> None:
        parsed = parse_responses_stream(SourceWithoutClose(), TextFormat())
        assert await parsed.final_result() == TextResult("x", CompletedOutcome())

    asyncio.run(run())


def test_pending_pull_is_interrupted_by_close_and_cannot_emit_late() -> None:
    class BlockingIterator(AsyncIterator[ResponsesEventLike]):
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.closed = 0

        async def __anext__(self) -> ResponsesEventLike:
            self.started.set()
            await asyncio.Future[None]()
            return _delta("late")

        async def aclose(self) -> None:
            self.closed += 1

    class BlockingSource(AsyncIterable[ResponsesEventLike]):
        def __init__(self) -> None:
            self.iterator = BlockingIterator()

        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            return self.iterator

    async def run() -> None:
        source = BlockingSource()
        parsed = parse_responses_stream(source, TextFormat())
        iterator = aiter(parsed)
        pending = asyncio.create_task(anext(iterator))
        await source.iterator.started.wait()
        await parsed.aclose()
        error = await _capture(pending)
        assert isinstance(error, ResponsesStreamAbortedError)
        assert source.iterator.closed == 1
        assert isinstance(
            await _capture(parsed.final_result()), ResponsesStreamAbortedError
        )

    asyncio.run(run())


def test_pending_async_generator_read_finishes_before_single_close() -> None:
    async def run() -> None:
        started = asyncio.Event()
        close_count = 0

        async def source() -> AsyncIterator[ResponsesEventLike]:
            nonlocal close_count
            try:
                started.set()
                await asyncio.Future[None]()
                yield _delta("late")
            finally:
                close_count += 1

        parsed = parse_responses_stream(source(), TextFormat())
        iterator = aiter(parsed)
        pending = asyncio.create_task(anext(iterator))
        await started.wait()
        await parsed.aclose()
        assert isinstance(await _capture(pending), ResponsesStreamAbortedError)
        assert close_count == 1
        assert isinstance(
            await _capture(parsed.final_result()), ResponsesStreamAbortedError
        )

    asyncio.run(run())


def test_close_is_idempotent_and_reentrant() -> None:
    async def run() -> None:
        parsed_ref: ParsedResponsesStream[str, TextResult] | None = None

        async def reenter() -> None:
            assert parsed_ref is not None
            await parsed_ref.aclose()

        source = TrackedSource([_delta("x")], close_callback=reenter)
        parsed_ref = parse_responses_stream(source, TextFormat())
        iterator = aiter(parsed_ref)
        await anext(iterator)
        await asyncio.wait_for(
            asyncio.gather(parsed_ref.aclose(), parsed_ref.aclose()), timeout=1
        )
        assert source.counts["close"] == 1

    asyncio.run(run())


def test_cancelled_pull_closes_source_and_propagates_cancellation() -> None:
    class BlockingIterator(AsyncIterator[ResponsesEventLike]):
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.closed = 0

        async def __anext__(self) -> ResponsesEventLike:
            self.started.set()
            await asyncio.Future[None]()
            return _delta("late")

        async def aclose(self) -> None:
            self.closed += 1

    class BlockingSource(AsyncIterable[ResponsesEventLike]):
        def __init__(self) -> None:
            self.iterator = BlockingIterator()

        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            return self.iterator

    async def run() -> None:
        source = BlockingSource()
        parsed = parse_responses_stream(source, TextFormat())
        iterator = aiter(parsed)
        pull = asyncio.create_task(anext(iterator))
        await source.iterator.started.wait()
        pull.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pull
        assert source.iterator.closed == 1
        assert isinstance(
            await _capture(parsed.final_result()), ResponsesStreamAbortedError
        )

    asyncio.run(run())


def test_cancelled_final_result_closes_source_and_propagates_cancellation() -> None:
    class BlockingIterator(AsyncIterator[ResponsesEventLike]):
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.closed = 0

        async def __anext__(self) -> ResponsesEventLike:
            self.started.set()
            await asyncio.Future[None]()
            return _delta("late")

        async def aclose(self) -> None:
            self.closed += 1

    class BlockingSource(AsyncIterable[ResponsesEventLike]):
        def __init__(self) -> None:
            self.iterator = BlockingIterator()

        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            return self.iterator

    async def run() -> None:
        source = BlockingSource()
        parsed = parse_responses_stream(source, TextFormat())
        final = asyncio.ensure_future(parsed.final_result())
        await source.iterator.started.wait()
        final.cancel()
        with pytest.raises(asyncio.CancelledError):
            await final
        assert source.iterator.closed == 1
        assert isinstance(
            await _capture(parsed.final_result()), ResponsesStreamAbortedError
        )

    asyncio.run(run())


def test_cancelled_close_continues_best_effort_cleanup() -> None:
    class SlowCloseIterator(AsyncIterator[ResponsesEventLike]):
        def __init__(self) -> None:
            self.emitted = False
            self.close_started = asyncio.Event()
            self.close_release = asyncio.Event()
            self.closed = 0

        async def __anext__(self) -> ResponsesEventLike:
            if self.emitted:
                raise StopAsyncIteration
            self.emitted = True
            return _delta("x")

        async def aclose(self) -> None:
            self.closed += 1
            self.close_started.set()
            await self.close_release.wait()

    class SlowCloseSource(AsyncIterable[ResponsesEventLike]):
        def __init__(self) -> None:
            self.iterator = SlowCloseIterator()

        def __aiter__(self) -> AsyncIterator[ResponsesEventLike]:
            return self.iterator

    async def run() -> None:
        source = SlowCloseSource()
        parsed = parse_responses_stream(source, TextFormat())
        iterator = aiter(parsed)
        await anext(iterator)
        closing = asyncio.create_task(parsed.aclose())
        await source.iterator.close_started.wait()
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        source.iterator.close_release.set()
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamAbortedError)
        assert source.iterator.closed == 1

    asyncio.run(run())


@dataclass(slots=True)
class SdkDelta:
    type: str
    item_id: str
    output_index: int
    content_index: int
    delta: str


@dataclass(slots=True)
class SdkDone:
    type: str
    item_id: str
    output_index: int
    content_index: int
    text: str


@dataclass(slots=True)
class SdkIncompleteDetails:
    reason: str


@dataclass(slots=True)
class SdkResponse:
    incomplete_details: SdkIncompleteDetails


@dataclass(slots=True)
class SdkIncomplete:
    type: str
    response: SdkResponse


def test_sdk_attribute_objects_and_mappings_interoperate_without_openai() -> None:
    async def source() -> AsyncIterator[ResponsesEventLike]:
        yield SdkDelta("response.output_text.delta", "message-sdk", 0, 0, "sdk")
        yield SdkDone("response.output_text.done", "message-sdk", 0, 0, "sdk")
        yield SdkIncomplete(
            "response.incomplete",
            SdkResponse(SdkIncompleteDetails("max_output")),
        )

    async def run() -> None:
        parsed = parse_responses_stream(source(), TextFormat())
        assert await parsed.final_result() == TextResult(
            "sdk", IncompleteOutcome("response", detail="max_output")
        )

    asyncio.run(run())


def test_stream_cannot_cross_event_loops() -> None:
    parsed = parse_responses_stream(_events(), TextFormat())
    asyncio.run(parsed.aclose())

    async def await_result() -> TextResult:
        return await parsed.final_result()

    with pytest.raises(RuntimeError, match="cannot cross event loops"):
        asyncio.run(await_result())


def test_public_stream_errors_have_stable_codes_and_context() -> None:
    cause = RuntimeError("cause")
    event = {"type": "error"}
    lane = OutputTextLane("message", 0, 1)
    errors: list[tuple[ResponsesStreamError, str]] = [
        (ResponsesStreamConsumedError(), "stream_consumed"),
        (ResponsesStreamAbortedError(), "stream_aborted"),
        (ResponsesStreamFailedError("failed", event), "response_failed"),
        (ResponsesStreamEventError("errored", event), "response_error"),
        (ResponsesStreamLaneError("lane", lane, None), "response_lane"),
        (ResponsesStreamRefusalError("refused", event), "response_refusal"),
        (ResponsesStreamParserError(cause), "parser_error"),
        (ResponsesStreamSourceError("next", cause), "source_error"),
    ]
    assert [(error.code, code) for error, code in errors] == [
        (code, code) for _error, code in errors
    ]
    assert cast(ResponsesStreamFailedError, errors[2][0]).event is event
    assert cast(ResponsesStreamEventError, errors[3][0]).event is event
    lane_error = cast(ResponsesStreamLaneError, errors[4][0])
    assert lane_error.expected == lane
    assert lane_error.received is None
    assert cast(ResponsesStreamRefusalError, errors[5][0]).event is event
    parser_error = cast(ResponsesStreamParserError, errors[6][0])
    assert parser_error.cause is cause
    assert parser_error.__cause__ is cause
    source_error = cast(ResponsesStreamSourceError, errors[7][0])
    assert source_error.operation == "next"
    assert source_error.cause is cause
    assert source_error.prior_error is None


def test_event_parser_and_package_failures_close_exactly_once() -> None:
    async def run() -> None:
        sources_and_formats: list[
            tuple[TrackedSource, ResponseFormat[str, TextResult]]
        ] = [
            (
                TrackedSource([{"type": "error", "message": "event failed"}]),
                TextFormat(),
            ),
            (
                TrackedSource([_delta("text")]),
                TextFormat(push_failure=RuntimeError("parser failed")),
            ),
            (
                TrackedSource([_delta("text")]),
                TextFormat(push_failure=InvalidSegmentationMaskError("invalid")),
            ),
        ]
        for source, format_ in sources_and_formats:
            parsed = parse_responses_stream(source, format_)
            first = await _capture(parsed.final_result())
            second = await _capture(parsed.final_result())
            assert first is second
            assert source.counts["close"] == 1

    asyncio.run(run())
