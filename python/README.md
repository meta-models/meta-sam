# meta-sam-parser

`meta-sam-parser` is the dependency-free native Python implementation of the
language-neutral SAM 3 segmentation protocol in the repository root. It provides
the strict complete-mask raster, COCO RLE, and SVG path conversions, incremental image/video line parser, and async
Responses API stream adapter.

## Install and use

Install the package from this directory with any standard Python installer:

```sh
python -m pip install .
```

## Direct parser API

Import supported APIs only from the package root. Deep imports are unsupported;
underscore-prefixed modules are implementation details and may change without notice.
Format factories are zero-argument and create isolated parser state. The example
feeds the parser one frame of SAM 3.1 output exactly as the API emits it - one line
per frame, `<Nf>` then comma-separated `id<|box;...|><|mask;...|>` records:

```python
from meta_sam_parser import CompletedOutcome, video_segmentation_format

output_text = (
    "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>"
    "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>"
    ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>"
    "<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n"
)

format_ = video_segmentation_format()
parser = format_.create_parser()

# Chunks may split anywhere, including inside a mask payload.
split = output_text.index(",1<|box")
for snapshot in parser.push(output_text[:split]):
    print(snapshot.revision, len(snapshot.records))
for snapshot in parser.push(output_text[split:]):
    print(snapshot.revision, len(snapshot.records))  # 1 4

finished = parser.finish(CompletedOutcome())
for snapshot in finished.events:
    print(snapshot.revision, len(snapshot.records))
result = finished.result
# Two box records and two mask records, object IDs "0" and "1", frame 0.
```

`push()` accepts arbitrarily split text chunks and returns zero or one cumulative
snapshot. `finish()` parses a final unterminated line and returns immutable final
events plus a result. Pass `IncompleteOutcome(reason="response", detail=...)` for
an explicitly incomplete response or `IncompleteOutcome(reason="eof")` when the
source ends without a terminal response event.

The same formats are normally passed to `parse_responses_stream()` so the adapter
can own lane validation, source cleanup, and terminal outcomes.

## Responses API streams

`parse_responses_stream(source, format)` accepts an async iterable of official
OpenAI Python SDK event objects, mappings with the same wire fields, or a mixture
of both. It has no runtime dependency on the OpenAI SDK. Field names stay in the
SDK/wire snake-case form (`item_id`, `output_index`, and `content_index`). An
output-text lane is finalized by either `response.output_text.done` or a
`response.content_part.done` event whose part type is `output_text`. The live SAM
Model API emits only the latter. If a stream emits both finalizers, their text
must match.

### Iterator-first

Use the parsed stream as both an async iterable and an async context manager. The
context manager is important when the loop may exit early because Python does not
implicitly call `aclose()` on arbitrary async iterators.

```python
from meta_sam_parser import parse_responses_stream, video_segmentation_format

async def consume(response_events):
    parsed = parse_responses_stream(response_events, video_segmentation_format())
    async with parsed:
        async for snapshot in parsed:
            print(snapshot.revision, len(snapshot.records))

    result = await parsed.final_result()
    return result
```

The first iterator request selects iterator mode. Calling `final_result()` selects
final-only mode synchronously, before its returned awaitable is awaited, so it
cannot race a later iterator claim. Pulls are serialized, snapshots are produced
on demand, and repeated `final_result()` calls await the same internal terminal
future. In iterator-first mode, requesting the final result does not consume the
remaining source: iteration must still reach completion. Exit early only through
`async with` or `aclose()`, which closes the source and makes the final result
raise `ResponsesStreamAbortedError`. Requesting another iterator raises
`ResponsesStreamConsumedError`.

### Final-only

Calling `final_result()` before requesting an iterator selects final-only mode.
The adapter drains and parses the source while suppressing intermediate snapshots:

```python
result = await parse_responses_stream(
    response_events,
    video_segmentation_format(),
).final_result()
```

### Early exit

Leaving an async context before a terminal response closes a created upstream
iterator once and makes `final_result()` raise `ResponsesStreamAbortedError`:

```python
parsed = parse_responses_stream(response_events, video_segmentation_format())
async with parsed:
    async for snapshot in parsed:
        if snapshot.records:
            break

# Raises ResponsesStreamAbortedError.
await parsed.final_result()
```

### Explicit ownership

Code that does not use `async with` must close the parsed stream explicitly:

```python
parsed = parse_responses_stream(response_events, video_segmentation_format())
try:
    iterator = aiter(parsed)
    first_snapshot = await anext(iterator)
    use(first_snapshot)
finally:
    await parsed.aclose()
```

`aclose()` is idempotent and safe while a source read is pending: it cancels and
waits for that read before closing the source owner exactly once. Both synchronous
and asynchronous close methods are supported, including closing an unstarted
source that owns transport resources. Cancellation of a pull, `final_result()`, or
`aclose()` propagates `asyncio.CancelledError` unchanged; cleanup continues on a
best-effort basis, and a later `final_result()` reports
`ResponsesStreamAbortedError` unless source cleanup itself fails. Parser and source
failures are exception-chained through `__cause__`.

## Immutable public model

All public values are frozen, slotted dataclasses. Observable collections are
tuples. The package root exports:

- Geometry, masks, and aliases: `FrameReference`, `SegmentationMaskBounds`,
  `SegmentationMask`, `SegmentationMaskEncoding`, `SegmentationMaskIdentity`, `SegmentationMedia`,
  `DiagnosticSeverity`, and `IncompleteReason`.
- Records: `SegmentationTextRecord`, `SegmentationBoxRecord`,
  `SegmentationMaskRecord`, and `SegmentationRecord`.
- Views: `SegmentationDiagnostic`, `ImageSegmentationSnapshot`,
  `VideoSegmentationSnapshot`, `SegmentationSnapshot`,
  `ImageSegmentationResult`, `VideoSegmentationResult`, and
  `SegmentationResult`.
- Outcomes and parser contracts: `CompletedOutcome`, `IncompleteOutcome`,
  `ResponseStreamOutcome`, `ParserFinish`, `ResponseFormatParser`, and
  `ResponseFormat`.
- Format factories: `image_segmentation_format` and
  `video_segmentation_format`.
- Stream lifecycle: `ParsedResponsesStream`, `parse_responses_stream`,
  `ResponsesEvent`, `ResponsesEventLike`, `OutputTextLane`, and
  `ResponseSourceOperation`.
- Errors: `ResponsesStreamError`, `ResponsesStreamConsumedError`,
  `ResponsesStreamAbortedError`, `ResponsesStreamFailedError`,
  `ResponsesStreamEventError`, `ResponsesStreamLaneError`,
  `ResponsesStreamRefusalError`, `ResponsesStreamParserError`,
  `ResponsesStreamSourceError` and `InvalidSegmentationMaskError`.
- Conversions: `decode_mask_to_raster`, `decode_mask_to_rle`,
  `decode_mask_to_svg_path`, and the frozen, slotted `RLEObject`.

Fields use snake case. A mask identity is the immutable tuple of media,
`frame_index`, and `object_id`; each later accepted mask for that identity gets
the next revision.

## Parsing behavior

SAM 3.1 returns segmentation as special-token text in one `output_text` lane, one
line per frame:

```text
<Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=<frameW>;h=<frameH>|><|mask;x=0;y=0;data=<H>,<W>,<enc>payload|>,id<|box;...|><|mask;...|>
```

`<Nf>` is the zero-based frame index; frames without a visible object emit no
line, so indices can skip. Each comma-separated record is a bare integer object
id - stable for an object across the frames of one response and not a dense
sequence - followed by one box and one mask. The parser retains the id as a string
in `object_id`. Box corners and the `w`/`h` frame size are source pixels; the
inclusive wire `x2`/`y2` become half-open `right`/`bottom`. The mask tuple is
`height,width,payload`, where the payload's first character selects the encoding:
`~` for `lossless` (the API default) or `!` for `one_bit`. The payload is base85,
not base64: after the marker its digits are printable ASCII `!` through `{` minus
the wire delimiters `" \ , ; < > |`, so it contains `*`, `$`, brackets, and
backticks, a base64 regex will not match it, and only the first character after
`H,W,` is the marker (`!` is also digit zero). Pass it through unchanged. Each record becomes one `SegmentationBoxRecord` followed by
one `SegmentationMaskRecord` whose `bounds` is the same half-open box. Image streams require frame zero and omit the frame from
normalized records; video records retain `frame.frame_index`. Every mask is
strictly decoded before insertion; an empty lane is a valid completed response
with no records.
The grammar is specified in the
[SAM 3 protocol](https://github.com/meta-models/meta-sam/blob/main/protocol/sam3.md).

Plain text remains an ordered text record. Malformed structured-looking lines
produce diagnostics and parsing continues. `raw_output` preserves every input
character exactly. Newline, CRLF, blank-line, and final unterminated-line behavior
matches the TypeScript parser. JavaScript safe-integer, ASCII token grammar, and
observable numeric parsing boundaries are preserved explicitly.

## Mask conversion

`decode_mask_to_raster()` strictly validates a complete `one_bit` or `lossless`
payload and returns immutable row-major `bytes` containing only `0` and `1`.
`decode_mask_to_rle()` returns exact COCO compressed RLE with `(height, width)`
size after transposing that raster to COCO column-major order.
`decode_mask_to_svg_path()` returns the polygonal `M`/`L`/`Z` path,
including multiple subpaths where needed, and returns `""` for an empty mask.
Structural checks cover supported encodings, positive JavaScript-safe dimensions
and area, packed payload shape and alphabet, prefixes, groups, tails, finalization,
and exact decoded length; the decoder imposes no project-defined area or payload
quota ceiling. Non-memory decoding failures are wrapped as
`InvalidSegmentationMaskError` with their cause, while `MemoryError` propagates
unchanged:

```python
from meta_sam_parser import (
    SegmentationMask,
    decode_mask_to_raster,
    decode_mask_to_rle,
    decode_mask_to_svg_path,
)

mask = SegmentationMask(
    encoding="one_bit",
    payload="!!!!!(QO(0lu8?",
    width=5,
    height=5,
)
raster = decode_mask_to_raster(mask)
coco_rle = decode_mask_to_rle(mask)
svg_path = decode_mask_to_svg_path(mask)
```

`raster` is immutable `bytes` in row-major order and contains only `0` and `1`.
`one_bit` payloads must pass a unique canonical round trip. `lossless` payloads
must use the strict packed envelope and contain enough arithmetic-coder
finalization to decode the declared raster, but they are not uniqueness-
canonicalized: trailing packed bytes and alternate unused finalization bytes may
encode the same raster and are accepted. The package does not expose a lossless
encoder or promise a canonical lossless spelling. Deep imports are implementation
details and are not supported.

## Python support

The declared range is CPython 3.10 and newer. Python 3.10 is the floor because
the public immutable types use standard-library slotted dataclasses and the
codebase uses Python 3.10 type syntax. There is no upper bound because the
runtime is pure Python, has no dependencies, and does not use CPython internals.
CI exercises Python 3.10 through 3.14.

## Development

Create and activate a virtual environment, then install the pinned development
toolchain:

```sh
python -m pip install -e '.[dev]'
python -m ruff format --check .
python -m ruff check .
python -m mypy
python -m pytest
python scripts/build_artifacts.py
python scripts/audit_distribution.py
```

The package audit verifies exact wheel and sdist allowlists, metadata, the typed
root API, archive safety, reproducible bytes, and isolated wheel and sdist
consumers. Each consumer runs `pip check`, runtime lifecycle cases, and strict
static typing against the installed distribution. The wheel consumer also
installs the official OpenAI Python SDK version pinned in
`requirements-openai.txt`, statically accepts `AsyncStream[ResponseStreamEvent]`,
and passes its attribute-object events through the installed parser while verifying
transport cleanup. OpenAI is a test-only consumer dependency and is not a runtime
package dependency.

## Releasing

`meta-sam-parser` is published to [PyPI](https://pypi.org/project/meta-sam-parser/)
by the `release PyPI distribution` workflow
(`.github/workflows/release-pypi.yml`). A release is one commit and one tag:

1. Bump `version` in `pyproject.toml`, run `node scripts/sync-compatibility` from
   the repository root so the compatibility matrix records the new version, and
   merge that change to `main`.
2. Push the tag `meta-sam-parser@<version>` at that merge commit on `main`. The
   workflow refuses a tag that does not match the manifest version, a tag whose
   commit is not on `main`, and a tag older than the latest `main` commit touching
   `python/`, `conformance/`, or `protocol/`, so a tag created before later fixes
   merged cannot publish stale source.
3. The workflow builds the reproducible wheel and sdist, runs the artifact and
   clean-consumer audits and the cross-language conformance suite, and then waits
   for approval in the `pypi` GitHub environment before uploading through PyPI
   trusted publishing (OIDC) with attestations. No PyPI credential is stored in the
   repository. It then creates the GitHub release for the tag.

A manual dispatch from `main` rehearses the same build and audits against
TestPyPI from the `testpypi` environment and never publishes to PyPI.

Build and audit the same artifacts locally from `python/`:

```sh
python -m pip install -e '.[dev]'
python scripts/build_artifacts.py
python scripts/audit_distribution.py
```

The build command replaces `dist/` with exactly one wheel and one sdist for the
version declared in `pyproject.toml`. The audit must pass against those exact
files; it does not upload, publish, or read credentials.

The Python conformance tests execute all 35 shared cases through
`parse_responses_stream()`, including stream lifecycle failures, completed and
incomplete outcomes, diagnostics, and masks. From the repository root, `node
scripts/validate-conformance` runs the same exact normalized cases in both
languages, while `node scripts/validate` runs complete validation and builds both
distributions.

## License

`meta-sam-parser` is licensed under the [SAM License](LICENSE).
