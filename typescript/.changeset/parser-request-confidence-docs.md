---
'@meta-sam/parser': patch
---

Document how to request the optional detection confidence: set the Responses metadata value `include_confidence` to `"true"`. The parser still accepts records without `c`. Parsing behavior is unchanged.
