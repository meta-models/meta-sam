---
'@meta-sam/graphics': patch
'@meta-sam/react': patch
---

Add opt-in box labels. With the new `boxLabels: true` renderer option, each visible box gets a label at its top-left corner: the `boxLabel` render option, the box's object ID, then its parser `confidence` with three decimals in parentheses, as `pillow 3 (0.945)`. The label and the confidence appear only when present, so the object ID is always shown. Labels are white text on a fill in the object color, sized in target CSS pixels; a label sits above its box when the target has room and inside it otherwise, and it shifts left to stay inside the target. Hidden objects and boxes from other video frames get no label. `render()` and `renderVideoFrame()` accept `boxLabel`, and the `@meta-sam/react` `Video` component forwards a new `boxLabel` prop. The new `formatBoxLabel` and `formatConfidence` exports return the label text, so legends can match the canvas. A box confidence outside 0 through 1 now rejects the update with `InvalidRenderOptionsError`.
