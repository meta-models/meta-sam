# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable
from typing import Literal

import pytest

from meta_sam_parser import (
    ImageSegmentationResult,
    ImageSegmentationSnapshot,
    ResponsesEventLike,
    ResponsesStreamAbortedError,
    ResponsesStreamSourceError,
    image_segmentation_format,
    parse_responses_stream,
)


async def _capture(awaitable: Awaitable[object]) -> object:
    try:
        return await awaitable
    except BaseException as error:
        return error


async def _settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


@pytest.mark.parametrize("mode", ["close", "pull", "queued_pull", "final"])
@pytest.mark.parametrize("repeat_cancel", [False, True])
def test_async_finally_survives_caller_cancellation(
    mode: str, repeat_cancel: bool
) -> None:
    async def run() -> None:
        entered = asyncio.Event()
        cleanup_started = asyncio.Event()
        release = asyncio.Event()
        log: list[str] = []

        async def source() -> AsyncGenerator[ResponsesEventLike, None]:
            try:
                entered.set()
                await asyncio.Future[None]()
                yield {"type": "response.created"}
            finally:
                log.append("cleanup started")
                cleanup_started.set()
                await release.wait()
                log.append("cleanup completed")

        generator = source()
        parsed = parse_responses_stream(generator, image_segmentation_format())
        iterator = aiter(parsed)
        pull = asyncio.create_task(anext(iterator))
        final = asyncio.ensure_future(parsed.final_result())
        await entered.wait()
        operation: (
            asyncio.Future[None]
            | asyncio.Future[ImageSegmentationSnapshot]
            | asyncio.Future[ImageSegmentationResult]
        )
        if mode == "close":
            operation = asyncio.ensure_future(parsed.aclose())
        elif mode == "pull":
            operation = pull
            operation.cancel()
        elif mode == "queued_pull":
            operation = asyncio.create_task(anext(iterator))
            await asyncio.sleep(0)
            operation.cancel()
        else:
            operation = asyncio.ensure_future(parsed.final_result())
            await asyncio.sleep(0)
            operation.cancel()
        await cleanup_started.wait()
        if repeat_cancel:
            operation.cancel()
            await _settle()
            operation.cancel()
        await _settle()
        try:
            assert log == ["cleanup started"]
            # A second close must join ongoing cleanup, even after its original
            # caller has stopped waiting for it.
            joined_close = asyncio.create_task(parsed.aclose())
            await _settle()
            assert not joined_close.done()
            assert not final.done()
        finally:
            release.set()
        outcomes = await asyncio.gather(
            _capture(operation), _capture(pull), _capture(final), _capture(joined_close)
        )
        assert log == ["cleanup started", "cleanup completed"]
        if mode == "close" and not repeat_cancel:
            assert outcomes[0] is None
        else:
            assert isinstance(outcomes[0], asyncio.CancelledError)
        assert isinstance(outcomes[2], ResponsesStreamAbortedError)
        assert outcomes[3] is None
        assert isinstance(await _capture(anext(generator)), StopAsyncIteration)
        await parsed.aclose()
        assert log == ["cleanup started", "cleanup completed"]

    async def bounded() -> None:
        await asyncio.wait_for(run(), timeout=2)

    asyncio.run(bounded())


@pytest.mark.parametrize("mode", ["close", "pull", "final"])
def test_cancelled_read_finally_failure_is_preserved(mode: str) -> None:
    async def run() -> None:
        entered = asyncio.Event()
        cause = RuntimeError("source cleanup failed")

        async def source() -> AsyncGenerator[ResponsesEventLike, None]:
            try:
                entered.set()
                await asyncio.Future[None]()
                yield {"type": "response.created"}
            finally:
                raise cause

        parsed = parse_responses_stream(source(), image_segmentation_format())
        iterator = aiter(parsed)
        pull = asyncio.create_task(anext(iterator))
        final = asyncio.ensure_future(parsed.final_result())
        await entered.wait()
        if mode == "close":
            closed = await _capture(parsed.aclose())
            assert isinstance(closed, ResponsesStreamSourceError)
        elif mode == "pull":
            pull.cancel()
        else:
            final.cancel()
        pulled, waited = await asyncio.gather(_capture(pull), _capture(final))
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamSourceError)
        assert error.operation == "return"
        assert error.cause is cause
        assert error.__cause__ is cause
        assert isinstance(error.prior_error, ResponsesStreamAbortedError)
        if mode == "pull":
            assert isinstance(pulled, asyncio.CancelledError)
        else:
            assert pulled is error
        if mode == "final":
            assert isinstance(waited, asyncio.CancelledError)
        else:
            assert waited is error
        assert await _capture(parsed.final_result()) is error

    async def bounded() -> None:
        await asyncio.wait_for(run(), timeout=2)

    asyncio.run(bounded())


@pytest.mark.parametrize("callback", ["aclose", "_close_source"])
def test_read_finalizer_can_reenter_cleanup_without_self_join(callback: str) -> None:
    async def run() -> None:
        entered = asyncio.Event()
        reentered = asyncio.Event()
        release = asyncio.Event()
        log: list[str] = []

        async def source() -> AsyncGenerator[ResponsesEventLike, None]:
            try:
                entered.set()
                await asyncio.Future[None]()
                yield {"type": "response.created"}
            finally:
                log.append("before reentry")
                if callback == "aclose":
                    await parsed.aclose()
                else:
                    # The close helper must not close a generator from inside
                    # its own active read, even if called by a source callback.
                    await parsed._close_source()
                log.append("after reentry")
                reentered.set()
                await release.wait()
                log.append("cleanup completed")

        generator = source()
        parsed = parse_responses_stream(generator, image_segmentation_format())
        final = asyncio.ensure_future(parsed.final_result())
        await entered.wait()
        close = asyncio.create_task(parsed.aclose())
        await reentered.wait()
        await _settle()
        try:
            assert not close.done()
            assert log == ["before reentry", "after reentry"]
        finally:
            release.set()
        await close
        assert isinstance(await _capture(final), ResponsesStreamAbortedError)
        assert log == ["before reentry", "after reentry", "cleanup completed"]
        assert isinstance(await _capture(anext(generator)), StopAsyncIteration)

    async def bounded() -> None:
        await asyncio.wait_for(run(), timeout=2)

    asyncio.run(bounded())


@pytest.mark.parametrize("callback", ["aclose", "_close_source"])
def test_read_callback_can_initiate_cleanup_without_self_join(callback: str) -> None:
    async def run() -> None:
        async def source() -> AsyncGenerator[ResponsesEventLike, None]:
            if callback == "aclose":
                await parsed.aclose()
            else:
                await parsed._close_source()
            yield {"type": "response.created"}

        parsed = parse_responses_stream(source(), image_segmentation_format())
        error = await _capture(parsed.final_result())
        assert isinstance(error, ResponsesStreamAbortedError)

    async def bounded() -> None:
        await asyncio.wait_for(run(), timeout=2)

    asyncio.run(bounded())


@pytest.mark.parametrize("callback", ["aclose", "_close_source"])
@pytest.mark.parametrize("termination", ["eof", "raise"])
def test_natural_finalizer_initiates_close_without_cancelling_itself(
    callback: str, termination: str
) -> None:
    async def run() -> None:
        reentered = asyncio.Event()
        release = asyncio.Event()
        log: list[str] = []
        cause = RuntimeError("source failed before cleanup")

        async def source() -> AsyncGenerator[ResponsesEventLike, None]:
            try:
                yield {"type": "response.created"}
                if termination == "raise":
                    raise cause
            finally:
                log.append("cleanup started")
                if callback == "aclose":
                    await parsed.aclose()
                else:
                    await parsed._close_source()
                log.append("reentry returned")
                reentered.set()
                await release.wait()
                log.append("cleanup completed")

        parsed = parse_responses_stream(source(), image_segmentation_format())
        final = asyncio.ensure_future(parsed.final_result())
        await reentered.wait()
        external_close = asyncio.create_task(parsed.aclose())
        await _settle()
        try:
            assert not final.done()
            assert not external_close.done()
            assert log == ["cleanup started", "reentry returned"]
        finally:
            release.set()
        error, closed = await asyncio.gather(_capture(final), _capture(external_close))
        assert log == ["cleanup started", "reentry returned", "cleanup completed"]
        if termination == "raise":
            assert isinstance(error, ResponsesStreamSourceError)
            assert error.cause is cause
            assert closed is error
        else:
            assert isinstance(error, ResponsesStreamAbortedError)
            assert closed is None

    async def bounded() -> None:
        await asyncio.wait_for(run(), timeout=2)

    asyncio.run(bounded())


@pytest.mark.parametrize("termination", ["return", "raise"])
def test_cleanup_accepts_cancelled_read_finishing_without_cancelled_error(
    termination: Literal["return", "raise"],
) -> None:
    async def run() -> None:
        entered = asyncio.Event()
        closed: list[str] = []

        async def source() -> AsyncGenerator[ResponsesEventLike, None]:
            try:
                entered.set()
                await asyncio.Future[None]()
            except asyncio.CancelledError:
                if termination == "return":
                    return
                raise StopAsyncIteration from None
            finally:
                closed.append("closed")
            yield {"type": "response.created"}

        parsed = parse_responses_stream(source(), image_segmentation_format())
        final = asyncio.ensure_future(parsed.final_result())
        await entered.wait()
        result = await _capture(parsed.aclose())
        error = await _capture(final)
        if termination == "return":
            assert result is None
            assert isinstance(error, ResponsesStreamAbortedError)
        else:
            # Explicit StopAsyncIteration raised by an async generator is a
            # RuntimeError under PEP 479 and must not be silently swallowed.
            assert isinstance(result, ResponsesStreamSourceError)
            assert error is result
        assert closed == ["closed"]

    asyncio.run(run())
