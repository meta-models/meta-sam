# SAM 3 API Playground

An interactive playground for the SAM 3 Responses API built on `@meta-sam/parser`, `@meta-sam/graphics`, `@meta-sam/video`, and `@meta-sam/react`. One surface handles both images and video: drop a file or pick an example, name what to segment, and watch the streamed output land on a single Canvas. Each mask is drawn as a translucent fill with a crisp contour in the object's color; the inspector's Outlines switch turns that contour off. The right-hand inspector shows the per-object legend (colors match the overlay), parsed records, the raw `output_text` stream with arrival times, and the concatenated raw output. The header independently controls light/dark/system mode and the six bundled Astryx visual themes; the visual theme is restored from local browser storage.

Examples are real media under `public/media` (one MP4 clip and two photos, copied from the public [`facebookresearch/sam3`](https://github.com/facebookresearch/sam3/tree/main/assets) assets under the same SAM License) and run against the live API, so a configured key is required to segment. Each example row shows a thumbnail: the photo itself, or a poster frame extracted from the clip in the browser, one clip at a time and cached for the session. Hovering or focusing a video row plays a muted, looped preview inside that thumbnail — one at a time, and never when the browser reports `prefers-reduced-motion: reduce`. Image requests are unary; a video is uploaded to the Model API Files endpoint once when it is selected, and each run streams against that handle, mapping each `<Nf>` frame onto the source packet timeline. The request rail loads the unfiltered Model API catalog from `GET /api/models`, defaults to `SAM_MODEL`, and keeps the selected model in the URL. The Code action renders copyable curl and TypeScript for the current model, noun phrase, media kind, and safe uploaded-file handle when one exists. The checked-in replay fixtures remain available for tests through `?fixture=<id>` and never appear in the UI.

## Setup

From `typescript/`:

```sh
npm run playground:install
npm run playground:dev
```

The playground defaults to `127.0.0.1:4173`. Pass `--port 5173` to choose another port.

Without configuration the playground still plays media locally, but the live API is unavailable and the Segment button stays disabled. Binding to a non-loopback host (`--host 0.0.0.0`) is refused whenever a key is configured.

## Live API on a local Mac

Create `typescript/examples/api-playground/.env.local` (from the repository root) on the Mac that runs the playground:

```dotenv
SAM_MODEL=your-model
SAM_API_KEY=your-key
# Optional; defaults to the authoritative Meta Model API base:
# SAM_API_BASE_URL=https://api.meta.ai/v1
```

Live is configured only when both `SAM_MODEL` and `SAM_API_KEY` are explicitly present and valid. `SAM_API_BASE_URL` is optional and defaults to `https://api.meta.ai/v1`. The playground does not claim that a model works end to end until a real credential has successfully exercised that deployment.

Keep the server bound to loopback on macOS; use an SSH tunnel for remote access rather than `--host 0.0.0.0`. The server reads the key from `.env.local`, while `/api/config` exposes only whether Live API is configured plus the credential-free endpoint origin and explicit default model label. When configured, `GET /api/models` relays `{ models: [{ id }], default }` from the upstream `/models` endpoint, validates and sorts at most 500 identifiers, bounds the upstream body to 256 KiB, and caches the result for five minutes. Neither endpoint exposes the API key or upstream error bodies. The browser never displays or accepts the key. Restart the playground after changing `.env.local`, and do not commit that file.

## Media input boundary

Video and images take different paths through the relay, and neither sends the same bytes twice.

Selecting or dropping a video — or staging a video example — uploads it immediately to `POST /api/files`: one `multipart/form-data` request whose only part is `media`, at most 20 MiB, sniffed from its bytes (MP4/ISO BMFF only; an image is refused because a Files handle would have nothing to reference). The relay forwards it to `{SAM_API_BASE_URL}/files` with `purpose=user_data` and answers `{"file_id":"file-…","bytes":N}`. The handle is opaque, is all the browser ever holds, and is validated against `/^file-[A-Za-z0-9_-]{1,120}$/` on both sides. Segment stays disabled until the upload is ready, and re-running or editing the prompt reuses the same handle; only changing the media uploads again.

`POST /api/responses` then carries `prompt`, an optional `model`, plus either `media` bytes (images, sent inline as a data URL in a unary request) or `file_id` (video, referenced from a streaming request). The model identifier must match `/^[A-Za-z0-9._:-]{1,120}$/`; omitting it uses the configured `SAM_MODEL` default. A request carrying both media forms, neither media form, or video bytes inline is refused. If the upstream reports a missing or expired video handle with 404 or 410, the relay answers `409 stale_file_handle`; the browser uploads once more and retries that run before reporting the error. Other upstream 4xx responses can come from the selected model or media contract and do not trigger a redundant upload.

Both routes share the same guards: same-origin authorization, `multipart/form-data` only, the 20 MiB cap, and `503 not_configured` when no key is configured. The browser additionally previews MOV and WebM files locally, but only MP4 is accepted for live segmentation because that is what the Files API supports.

The production stream closes each text lane with `response.content_part.done`; the relay synthesizes the `response.output_text.done` event the parser expects and drops duplicate finalizers.

## Commands

```sh
npm run playground:build
npm run playground:test
npm run playground:test:browser
npm run playground:test:packed
npm run playground:preview
```

`playground:test:packed` is the release-shaped consumer gate. It builds the workspace packages, creates audited canonical npm tarballs, copies the playground into a disposable directory without local environment files or build output, regenerates only that copy’s lockfile with the repository-pinned npm version, and installs with lifecycle scripts disabled. It then verifies package identities, SAM License declarations and exact license bytes, tarball integrities, root exports, declarations, non-linked dependency resolution, a production Vite build, and focused image and video Playwright flows against the isolated production server. The disposable directory is removed on success or failure; the committed playground lockfile is never changed.

## License

The playground and its first-party source are licensed under the [SAM License](../../../LICENSE).
