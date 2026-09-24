---
'@meta-sam/parser': patch
---

Read SAM API records tolerantly and expose the optional detection confidence. Box and mask fields may appear in any order, with whitespace around keys and values and empty fields. Keys and tokens the parser does not know, and fields in the frame header, no longer reject the line: the record is kept and an `ignored_field` or `ignored_token` diagnostic with `severity: 'warning'` is reported once per stream. The optional `c` field on each token becomes `confidence` on `SegmentationBoxRecord` and `SegmentationMaskRecord`; it is absent when the API omits `c`, and a value that is not a number from 0 through 1 is ignored with an `ignored_confidence` warning while the box and mask are kept. A repeated field other than `c`, a missing required field, or a record without exactly one box and one mask token remains a `malformed_record` error. Shared conformance cases cover the new rules in both the TypeScript and Python parsers.
