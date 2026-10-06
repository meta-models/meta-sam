---
'@meta-sam/graphics': patch
---

Add an `objectColor` renderer option that chooses each object's color from its object ID. The color is used for the mask fill, mask outline, box, and box label fill; label text stays white. The renderer calls it once per visible object per render, and a value that is not a string with at least one non-whitespace character makes `render()` throw `InvalidRenderOptionsError` before it draws. Without the option, colors are unchanged: each object ID hashes to one of eight colors, as the exported `objectColor(id)` returns.
