# SAM 3 text format

This document defines the segmentation text format shared by every implementation in this repository. SAM 3.1 returns segmentation as special-token text in one Responses API `output_text` lane, one line per frame. That wire grammar is the only structured input the parsers accept; each newline commits one record set and arbitrary chunk boundaries do not affect the result.

## SAM API output

SAM API responses emit one line per frame. A line is a frame marker `<Nf>` followed by comma-separated records; each record is a bare integer object id, one box, then one mask. Implementations normalize every record into one ordered box record followed by one mask record:

```text
<7f>0<|box;x1=10;y1=20;x2=14;y2=24;w=100;h=80|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>
```

Each token may also carry an optional detection confidence `c`:

```text
<7f>0<|box;x1=10;y1=20;x2=14;y2=24;w=100;h=80;c=0.75|><|mask;x=0;y=0;c=0.75;data=5,5,!!!!!(QO(0lu8?|>
```

A line may contain more than one object segment after the frame header. For compatibility with emitted SAM output, each segment may be preceded by one comma; the comma is optional, including before the first segment. In each segment:

- The object token after the frame header or an optional comma is a non-negative ASCII-decimal ID. It is stable for one object across the frames of a response, may contain multiple digits, and need not be contiguous or dense (a line may carry `0` and `2`); implementations retain it as a string in normalized records and must not derive it from record position.
- `<Nf>` supplies a non-negative safe frame index. Frames without a visible object emit no line, so indices may skip. Image records require `N` to be zero and normalize it to no frame reference; video records retain `N`. The frame marker may carry `;`-separated fields before its `>`, as in `<7f;example=1>`; implementations ignore them and report an `ignored_field` warning.
- After the object id, a record is a sequence of tokens. A token is `<|name|>` or `<|name;fields|>`, where `name` matches `[A-Za-z][A-Za-z0-9_.-]*`. A record needs exactly one `box` token and exactly one `mask` token, in any order. Implementations ignore other tokens and report an `ignored_token` warning. Text between tokens that is not a token makes the record malformed.
- Token fields are `;`-separated `key=value` pairs that implementations read by name; their order is not significant. Implementations trim whitespace around keys and values and skip empty fields. A field without `=` has a key and no value. A value extends to the next `;` or to the token's closing `|>`, and may contain `=`. Implementations ignore keys this document does not define and report an `ignored_field` warning, so a new API field does not break parsing. A repeated box or mask key other than `c` makes the record malformed.
- The box requires `x1`, `y1`, `x2`, and `y2` as ASCII-decimal integers with an optional leading `-`, and `w` and `h` as unsigned ASCII-decimal integers. The mask requires `x=0`, `y=0`, and `data`. A missing required field or a value outside this syntax makes the record malformed.
- `x1`, `y1`, `x2`, and `y2` are integer source-media coordinates. The source syntax uses inclusive `x2` and `y2`; normalized boxes use half-open `right = x2 + 1` and `bottom = y2 + 1`.
- `w` and `h` are positive source dimensions. The complete inclusive box must lie inside them.
- The mask `data` value is the tuple `height,width,payload`. A payload beginning with `~` selects `lossless`, the API default; one beginning with `!` selects `one_bit`. The payload alphabet excludes `,`, `;`, `<`, `>`, `|`, `"`, and `\`, so the tuple, the field separator, and the closing `|>` are unambiguous.
- The normalized mask carries the same half-open box as its bounds.
- `c` is optional on both tokens. It is the detection confidence, written as a decimal number: an optional `-`, digits with an optional fraction or a fraction alone, and an optional exponent (`0.75`, `1`, `.25`, `7.5e-1`, `1e-05`). Its value must be finite and from 0 through 1; `-0` normalizes to `0`. Any other `c` value, a `c` without a value, and a repeated `c` are ignored: the record is kept without that token's confidence, and an `ignored_confidence` warning is reported. The box record and the mask record each carry their own token's value as `confidence`. Implementations must not require the box and mask values to match. When a token has no `c`, its record has no confidence. A missing confidence does not mean zero.

`c` is optional per record, so one response can mix records with and without `c`.

Every diagnostic has a severity. An `error` means the parser dropped data. A `warning` means the parser kept the record and ignored part of the input. The warning codes are `ignored_field`, `ignored_token`, and `ignored_confidence`. Each warning code is reported once per stream for each field key, token name, or `c`, on the first line where it applies. A malformed record reports no warnings, so a later accepted record reports them instead.

An empty lane — zero matches — is a valid completed response with no records. Any malformed API-looking line, including a bare frame header such as `<0f>`, produces a `malformed_record` diagnostic. Any malformed object segment diagnoses the whole line. Already accepted segments remain ordered records, matching streaming parser behavior.

## Mask payload encoding

The mask payload is **base85 text, not base64**. Its first character is the encoding marker (`~` lossless, `!` one_bit); everything after it is base85 digits. The 85 digits are the printable ASCII characters from `!` through `{`, in ASCII order, minus the seven the wire grammar uses as delimiters — `"`, `\`, `,`, `;`, `<`, `>`, and `|`:

```text
!#$%&'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{
```

`}` and `~` are never digits: `~` appears only as the lossless marker, so a payload contains `~` exactly when it is lossless, and then only as its first character. `!` is both the one_bit marker and digit zero, so it appears freely.

Consequences for anyone reading the wire directly:

- A base64 character class such as `[A-Za-z0-9+/=]` will not match a payload. Use the alphabet above, or, simpler, take every character up to the closing `|>`: no delimiter character can appear inside a payload, so the `data=H,W,` tuple and the `|>` terminator are unambiguous.
- The payload alphabet contains `=` and letters, so a payload can contain text such as `c=`. Find fields by splitting the token body on `;`, never by searching the token text for `key=`.
- The payload contains characters that are special in regular expressions and shells — `*`, `$`, `(`, `)`, `[`, `]`, `{`, `^`, `?`, `+`, `.`, and backtick. Do not interpolate a payload into a pattern or an unquoted shell word.
- Only the **first** character after `H,W,` is the encoding marker (`~` lossless, `!` one_bit). Do not scan for markers further in: `!` is also digit zero, and a run of `!` at the start of any payload is normal (the length prefix is five base85 digits, so short masks begin `!!!!`).
- Payloads are opaque. Pass them to `decodeMaskToRaster` / `decode_mask_to_raster` unchanged; they are never partial and there is nothing to trim or unescape.

The payload begins with a five-character base85 length prefix followed by the arithmetic-coded body, packed four bytes to five characters. `one_bit` bodies start with `!` and decode in row-major order to bytes containing only `0` and `1`. `lossless` bodies start with `~`; decoding thresholds coverage bytes at 129, producing the same row-major binary vector as `one_bit`.

A `one_bit` payload is accepted only when its alphabet, packed groups, declared length, arithmetic-coder finalization, and canonical round trip all validate for the declared dimensions. Truncated, trailing, and alternate noncanonical spellings are rejected. `lossless` payloads use the same strict envelope, but trailing packed bytes and alternate unused finalization bytes may encode the same raster and are accepted; no canonical lossless encoder is exposed.

## Streaming and outcomes

The stream adapter consumes exactly one output-text lane, identified by the official `item_id`, `output_index`, and `content_index` event fields. Interleaved output-text lanes, invalid lane identities, output-text deltas after finalization, and finalized text that conflicts with accumulated deltas are rejected. Refusal delta and done events, and `response.content_part.done` with a `refusal` part, are terminal typed failures. `reasoning_text` parts are ignored and cannot finalize the output-text lane.

A text delta contributes one parser chunk. Either `response.output_text.done` with string `text`, or `response.content_part.done` with an `output_text` part and string `part.text`, finalizes the lane. When deltas were seen, finalized text must equal their exact concatenation; otherwise, it supplies the complete parser input. Both finalizer event types may occur once for the same lane, in either order, only with identical text; the second distinct finalizer does not feed the parser again. Any repeated finalizer event type is rejected, even after the other type was accepted. A second distinct finalizer with different text is rejected.

Completed and explicit incomplete terminal events require one finalized output-text lane. End of input does not. `response.output_item.done` and `response.completed.response.output` do not establish or finalize a lane: their aggregate contents are not used as fallbacks or reconciled against finalized lane text. Supporting multiple output-text parts or recovering output solely from aggregate events is outside this adapter's contract.

Snapshots are immutable cumulative views with a monotonic `revision`. A parser push emits at most one snapshot, after all complete lines in that chunk have been processed, and only when records or diagnostics changed. Finishing emits a final snapshot when a non-empty buffered line changes the view. Snapshots contain all records and diagnostics accepted so far plus all raw output received so far.

Mask identity is derived from media, frame reference, and object identifier. A later complete mask for the same identity increments its mask revision and replaces the prior mask during rendering.

A completed response produces a `completed` outcome. A response explicitly marked incomplete produces an `incomplete` outcome with its detail when available. End of input without either terminal event produces an `incomplete` outcome with reason `eof`. Failed responses, error events, source failures, parser failures, and consumers that stop iteration early produce terminal typed errors.

## Structural validation

Segmentation parsers retain every input character, accepted record, and diagnostic;
the format factories do not define parser-level resource quotas. Complete mask
records and direct decoder calls share the same intrinsic decoder. It requires a
supported encoding, positive JavaScript-safe dimensions whose product is also
safe, valid packed shape and alphabet, the correct prefix, valid groups and tail,
sufficient finalization, a canonical `one_bit` round trip, and a decoded output of
exactly `width * height` bytes. These are structural validity checks rather than
project-defined area or payload ceilings.
