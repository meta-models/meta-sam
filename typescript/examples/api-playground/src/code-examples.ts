/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { MediaKind } from './model';

const DOCUMENTED_ENDPOINT_ORIGIN = 'https://api.meta.ai';

export interface CodeExampleRequest {
  readonly endpointOrigin: string | null;
  readonly model: string;
  readonly prompt: string;
  readonly mediaKind: MediaKind;
  readonly filename: string;
  readonly mimeType: string;
  readonly fileId?: string | null;
  /** Minimum detection score for an image request, sent as metadata. */
  readonly scoreThreshold?: number | null;
  /** Ask for the optional `c` confidence, sent as metadata. */
  readonly includeConfidence?: boolean | null;
}

export interface CodeExamples {
  readonly curl: string;
  readonly typescript: string;
}

function apiBase(endpointOrigin: string | null): string {
  try {
    return `${new URL(endpointOrigin ?? DOCUMENTED_ENDPOINT_ORIGIN).origin}/v1`;
  } catch {
    return `${DOCUMENTED_ENDPOINT_ORIGIN}/v1`;
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9._/@:+=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function unquotedHeredoc(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('$', '\\$').replaceAll('`', '\\`');
}

function requestMetadata(
  request: CodeExampleRequest,
  options: { readonly scoreThreshold: boolean },
): { metadata?: Record<string, string> } {
  const metadata: Record<string, string> = {
    ...(options.scoreThreshold &&
    request.scoreThreshold !== undefined &&
    request.scoreThreshold !== null
      ? { score_threshold: String(request.scoreThreshold) }
      : {}),
    ...(request.includeConfidence === true ? { include_confidence: 'true' } : {}),
  };
  return Object.keys(metadata).length === 0 ? {} : { metadata };
}

function imageBody(request: CodeExampleRequest, imageUrl: string) {
  return {
    model: request.model,
    stream: false,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: request.prompt },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
    ...requestMetadata(request, { scoreThreshold: true }),
  };
}

function videoBody(request: CodeExampleRequest, fileId: string) {
  return {
    model: request.model,
    stream: true,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: request.prompt },
          { type: 'input_video', file_id: fileId },
        ],
      },
    ],
    ...requestMetadata(request, { scoreThreshold: false }),
  };
}

function curlExample(request: CodeExampleRequest, base: string): string {
  if (request.mediaKind === 'image') {
    const filename = shellArgument(request.filename);
    const marker = '__IMAGE_BASE64__';
    const imageUrl = `data:${request.mimeType};base64,${marker}`;
    const payload = unquotedHeredoc(
      JSON.stringify(imageBody(request, imageUrl), null, 2),
    ).replace(marker, '$IMAGE_BASE64');
    return `IMAGE_BASE64=$(base64 -i ${filename} | tr -d '\\n')

curl ${base}/responses \\
  -H "Authorization: Bearer $SAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d @- <<EOF
${payload}
EOF`;
  }

  return `curl ${base}/files \\
  -H "Authorization: Bearer $SAM_API_KEY" \\
  -F purpose=user_data \\
  -F ${shellArgument(`file=@${request.filename}`)}

curl -N ${base}/responses \\
  -H "Authorization: Bearer $SAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d @- <<'EOF'
${JSON.stringify(videoBody(request, request.fileId ?? '<file-id from step 1>'), null, 2)}
EOF`;
}

const rendererUsage = `const renderer = new SegmentationRenderer();
for await (const snapshot of parsed) {
  await renderer.update(snapshot);
}
const result = await parsed.finalResult;
await renderer.update(result);`;

function typescriptImage(request: CodeExampleRequest, base: string): string {
  const body = JSON.stringify(imageBody(request, '__IMAGE_URL__'), null, 2).replace(
    '"__IMAGE_URL__"',
    'imageUrl',
  );
  return `import { readFile } from 'node:fs/promises';
import { formats, parseResponsesStream, type ResponsesEvent } from '@meta-sam/parser';
import { SegmentationRenderer } from '@meta-sam/graphics';

const apiKey = process.env.SAM_API_KEY;
if (!apiKey) throw new Error('Set SAM_API_KEY.');

const imageBytes = await readFile(${JSON.stringify(request.filename)});
const imageUrl = ${JSON.stringify(`data:${request.mimeType};base64,`)} + imageBytes.toString('base64');

const response = await fetch('${base}/responses', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify(${body}),
});
if (!response.ok) throw new Error(\`Responses API returned \${response.status}.\`);
const payload = (await response.json()) as {
  output?: Array<{ id?: string; content?: Array<{ type?: string; text?: string }> }>;
};
const item = payload.output?.find((entry) =>
  entry.content?.some((part) => part.type === 'output_text'),
);
const text = item?.content?.find((part) => part.type === 'output_text')?.text ?? '';

async function* events(): AsyncIterable<ResponsesEvent> {
  const lane = { item_id: item?.id ?? 'message-1', output_index: 0, content_index: 0 };
  yield { type: 'response.output_text.delta', ...lane, delta: text };
  yield { type: 'response.output_text.done', ...lane, text };
  yield { type: 'response.completed' };
}

const parsed = parseResponsesStream(events(), formats.segmentation.image());
${rendererUsage}`;
}

function typescriptVideo(request: CodeExampleRequest, base: string): string {
  const needsUpload = request.fileId === undefined || request.fileId === null;
  const upload = needsUpload
    ? `const videoBytes = await readFile(${JSON.stringify(request.filename)});
const upload = new FormData();
upload.append('purpose', 'user_data');
upload.append(
  'file',
  new Blob([new Uint8Array(videoBytes)], { type: ${JSON.stringify(request.mimeType)} }),
  ${JSON.stringify(request.filename)},
);
const uploadResponse = await fetch('${base}/files', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${apiKey}\` },
  body: upload,
});
if (!uploadResponse.ok) throw new Error(\`Files API returned \${uploadResponse.status}.\`);
const { id: fileId } = (await uploadResponse.json()) as { id: string };`
    : `const fileId = '${request.fileId}';`;
  const body = JSON.stringify(videoBody(request, '__FILE_ID__'), null, 2).replace(
    '"__FILE_ID__"',
    'fileId',
  );
  return `${needsUpload ? "import { readFile } from 'node:fs/promises';\n" : ''}import { formats, parseResponsesStream, type ResponsesEvent } from '@meta-sam/parser';
import { SegmentationRenderer } from '@meta-sam/graphics';

const apiKey = process.env.SAM_API_KEY;
if (!apiKey) throw new Error('Set SAM_API_KEY.');

${upload}

const response = await fetch('${base}/responses', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify(${body}),
});
if (!response.ok || response.body === null) {
  throw new Error(\`Responses API returned \${response.status}.\`);
}

function eventFromBlock(block: string): ResponsesEvent | null {
  const data = block
    .split('\\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\\n');
  return data && data !== '[DONE]' ? (JSON.parse(data) as ResponsesEvent) : null;
}

async function* events(): AsyncIterable<ResponsesEvent> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let pendingCarriageReturn = false;
  for (;;) {
    const { value = '', done } = await reader.read();
    let chunk = pendingCarriageReturn ? '\\r' + value : value;
    pendingCarriageReturn = false;
    if (!done && chunk.endsWith('\\r')) {
      chunk = chunk.slice(0, -1);
      pendingCarriageReturn = true;
    }
    buffer += chunk.replace(/\\r\\n|\\r/g, '\\n');
    for (
      let boundary = buffer.indexOf('\\n\\n');
      boundary >= 0;
      boundary = buffer.indexOf('\\n\\n')
    ) {
      const event = eventFromBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event !== null) yield event;
    }
    if (done) break;
  }
  const finalEvent = eventFromBlock(buffer);
  if (finalEvent !== null) yield finalEvent;
}

const parsed = parseResponsesStream(events(), formats.segmentation.video());
${rendererUsage}`;
}

export function createCodeExamples(request: CodeExampleRequest): CodeExamples {
  const normalized = { ...request, prompt: request.prompt.trim() };
  const base = apiBase(normalized.endpointOrigin);
  return {
    curl: curlExample(normalized, base),
    typescript:
      normalized.mediaKind === 'image'
        ? typescriptImage(normalized, base)
        : typescriptVideo(normalized, base),
  };
}

export function inferMediaMimeType(filename: string, kind: MediaKind): string {
  const extension = filename.toLowerCase().split('.').at(-1);
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'mov') return 'video/quicktime';
  return kind === 'image' ? 'image/jpeg' : 'video/mp4';
}
