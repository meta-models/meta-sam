# TypeScript implementation

TypeScript packages for SAM 3 streaming segmentation:

- `@meta-sam/parser` converts Responses API events into immutable segmentation snapshots.
- `@meta-sam/graphics` retains traced mask paths and renders Canvas 2D overlays.
- `@meta-sam/video` provides Canvas-based, packet-exact Mediabunny playback with a Web Audio master clock.
- `@meta-sam/react` provides a single-canvas React component and hook for video and graphics.

Packages expose their documented root entry points; deep imports are unsupported. Licensed under the [SAM License](../LICENSE). Contributions are welcome—see [`../CONTRIBUTING.md`](../CONTRIBUTING.md) and our [Code of Conduct](../CODE_OF_CONDUCT.md).

## Requirements

- Node.js 20.17 or newer within npm's supported release lines
- npm 11 or newer

## Development

Run these commands from `typescript/`:

```sh
npm run setup
npm run validate
```

Individual commands are available for `build`, `typecheck`, `test`, `format:check`, `pack:check`, and `consumer:check`. Browser media validation runs with `test:browser`; the dedicated VFR and stress gates run with `test:media-performance`. Run `npm run conformance:check` to execute the shared cases through the TypeScript parser.

See [`docs/media-performance.md`](docs/media-performance.md) for playback metrics, performance thresholds, and the anti-flake policy; [`../protocol/sam3.md`](../protocol/sam3.md) for the shared SAM 3 text grammar; and [`docs/releasing.md`](docs/releasing.md) for the TypeScript release process.
