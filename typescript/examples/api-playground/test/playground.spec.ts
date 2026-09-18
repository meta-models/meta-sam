/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
]);

const LANE = { item_id: 'live', output_index: 0, content_index: 0 };
// The two-objects fixture's records: object 0 (an 8×8 marker) and object 1
// (a 48×32 panel) in a 96×64 image, as the SAM API emits them.
const FIRST =
  "<0f>0<|box;x1=4;y1=4;x2=11;y2=11;w=96;h=64|><|mask;x=0;y=0;data=8,8,!!!!!'y:Duu@D|>\n";
const SECOND =
  '<0f>1<|box;x1=24;y1=16;x2=71;y2=47;w=96;h=64|><|mask;x=0;y=0;data=32,48,!!!!!(y:SktC`w|>\n';

function ndjson(events: readonly object[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

async function mockLive(
  page: Page,
  onRequest?: (request: import('@playwright/test').Request) => void,
  events: readonly object[] = [
    { type: 'response.output_text.delta', ...LANE, delta: FIRST },
    { type: 'response.output_text.delta', ...LANE, delta: SECOND },
    { type: 'response.output_text.done', ...LANE, text: `${FIRST}${SECOND}` },
    { type: 'response.completed' },
  ],
) {
  const relay = { fileUploads: 0, responseBodies: [] as string[] };
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        endpointOrigin: 'https://sam.example.test',
        model: 'configured-model',
      }),
    }),
  );
  await page.route('**/api/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'configured-model' },
          { id: 'alpha-model' },
          { id: 'beta-model' },
          { id: 'sam-3' },
          { id: 'sam-3.1' },
          { id: 'sam-3.1-example' },
          { id: 'example-video-model' },
          { id: 'other-vision-model' },
          { id: 'zeta-model' },
        ],
        default: 'configured-model',
      }),
    }),
  );
  await page.route('**/api/files', async (route) => {
    relay.fileUploads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ file_id: 'file-playground123', bytes: 4_096 }),
    });
  });
  await page.route('**/api/responses', async (route) => {
    relay.responseBodies.push(route.request().postData() ?? '');
    onRequest?.(route.request());
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body: ndjson(events),
    });
  });
  return relay;
}

async function canvasPixel(canvas: Locator, xRatio = 0.5, yRatio = 0.5) {
  return await canvas.evaluate(
    (element: HTMLCanvasElement, ratios) => {
      const context = element.getContext('2d');
      if (context === null) throw new Error('Canvas context unavailable.');
      const x = Math.min(element.width - 1, Math.floor(element.width * ratios.x));
      const y = Math.min(element.height - 1, Math.floor(element.height * ratios.y));
      return [...context.getImageData(x, y, 1, 1).data];
    },
    { x: xRatio, y: yRatio },
  );
}

/** Full-canvas snapshot, for assertions a single sample point cannot make. */
async function canvasBytes(canvas: Locator): Promise<number[]> {
  return await canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d');
    if (context === null) throw new Error('Canvas context unavailable.');
    return [...context.getImageData(0, 0, element.width, element.height).data];
  });
}

function changedPixels(a: number[], b: number[]) {
  let changed = 0;
  for (let index = 0; index < a.length; index += 4) {
    const delta =
      Math.abs((a[index] ?? 0) - (b[index] ?? 0)) +
      Math.abs((a[index + 1] ?? 0) - (b[index + 1] ?? 0)) +
      Math.abs((a[index + 2] ?? 0) - (b[index + 2] ?? 0));
    if (delta > 6) changed += 1;
  }
  return changed;
}

function pixelDelta(a: number[], b: number[]) {
  return a.reduce(
    (sum, channel, index) => sum + Math.abs(channel - (b[index] ?? 0)),
    0,
  );
}

async function openFixture(page: Page, id: string) {
  await page.goto(`/?fixture=${id}`);
  await expect(page.getByTestId('media-canvas')).toBeVisible();
  const run = page.getByRole('button', { name: 'Run replay', exact: true });
  await expect(run).toBeEnabled({ timeout: 15_000 });
  return run;
}

async function runReplay(page: Page, status: RegExp | string) {
  await page.getByRole('button', { name: 'Run replay', exact: true }).click();
  await expect(page.getByTestId('run-status')).toContainText(status, {
    timeout: 30_000,
  });
}

async function renderCounts(page: Page): Promise<Record<string, number>> {
  return await page.evaluate(() => ({ ...window.__playgroundRenders }));
}

function expectUnchanged(
  before: Record<string, number>,
  after: Record<string, number>,
  components: readonly string[],
): void {
  for (const component of components) {
    expect(after[component]).toBe(before[component]);
  }
}

test.describe('theme preferences', () => {
  test('switches visual theme and restores it after reload', async ({ page }) => {
    await page.goto('/');
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-astryx-theme', 'neutral');
    const neutralAccent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-accent'),
    );

    await page.getByRole('combobox', { name: 'Visual theme' }).click();
    await page.getByRole('option', { name: 'Gothic' }).click();
    await expect(root).toHaveAttribute('data-astryx-theme', 'gothic');
    const gothicAccent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-accent'),
    );
    expect(gothicAccent).not.toBe(neutralAccent);

    await page.reload();
    await expect(root).toHaveAttribute('data-astryx-theme', 'gothic');
    await expect(page.getByRole('combobox', { name: 'Visual theme' })).toHaveText(
      'Gothic',
    );
  });
});

test.describe('empty surface', () => {
  test('starts without media and keeps segmentation disabled', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByText('Drop an image or video, or pick an example'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Segment', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('list', { name: 'Examples' }).getByRole('button'),
    ).toHaveCount(3);
    await expect(page.getByRole('tab', { name: /Objects \(0\)/ })).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    expect(await page.evaluate(() => window.__playgroundRenders)).toBeUndefined();
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /SAM 3/,
    );
  });
  test('explains when the live API is not configured', async ({ page }) => {
    await page.goto('/?example=truck');
    await expect(page.getByTestId('media-canvas')).toBeVisible();
    await expect(
      page.getByText('Live API not configured', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('model-typeahead')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(
      page.getByRole('button', { name: 'Segment', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Noun phrase' })).toHaveValue(
      'wheel',
    );
  });
});

test.describe('image replay fixtures', () => {
  test('streams cumulative evidence, renders overlay pixels, and fills the inspector', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await openFixture(page, 'two-objects');
    await expect(page.getByRole('textbox', { name: 'Noun phrase' })).toBeEnabled();
    const canvas = page.getByTestId('media-canvas');
    const before = await canvasPixel(canvas, 0.35, 0.5);

    await runReplay(page, 'completed');
    await expect(canvas).toHaveAttribute('data-revision', '2');
    await expect(page.getByRole('tab', { name: 'Objects (2)' })).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Object legend' }).locator('li'),
    ).toHaveCount(2);
    const after = await canvasPixel(canvas, 0.35, 0.5);
    expect(pixelDelta(after, before)).toBeGreaterThan(20);

    await page.getByRole('tab', { name: 'Records (4)' }).click();
    await expect(
      page.getByRole('list', { name: 'Output records' }).locator('li'),
    ).toHaveCount(4);
    await expect(page.getByText(/1 · mask 48×32/)).toBeVisible();

    await page.getByRole('tab', { name: /Stream \(/ }).click();
    const streamList = page.getByRole('list', { name: 'Stream events' });
    const rows = streamList.locator('li');
    await expect(streamList).toHaveAttribute('data-total', '3');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('delta');
    await expect(rows.last()).toContainText('response.completed');
    await expect(page.getByRole('button', { name: 'Download JSONL' })).toBeEnabled();

    await page.getByRole('tab', { name: 'Raw' }).click();
    await expect(page.getByTestId('raw-output')).toContainText(
      '<0f>0<|box;x1=4;y1=4;x2=11;y2=11;w=96;h=64|>',
    );
    expect(pageErrors).toEqual([]);
  });

  test('isolates prompt typing from completed output surfaces', async ({ page }) => {
    await openFixture(page, 'two-objects');
    await runReplay(page, 'completed');
    await page.getByRole('tab', { name: /Stream \(/ }).click();
    await expect(page.getByRole('list', { name: 'Stream events' })).toHaveAttribute(
      'data-total',
      '3',
    );

    const input = page.getByRole('textbox', { name: 'Noun phrase' });
    const initialPrompt = await input.inputValue();
    const beforeStream = await renderCounts(page);
    await input.press('End');
    await input.pressSequentially('abcdefghij');
    await expect(input).toHaveValue(`${initialPrompt}abcdefghij`);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('prompt'))
      .toBe(`${initialPrompt}abcdefghij`);
    const afterStream = await renderCounts(page);
    expect(afterStream.App).toBeGreaterThan(beforeStream.App ?? 0);
    expectUnchanged(beforeStream, afterStream, [
      'Stage',
      'Inspector',
      'ExampleList',
      'StreamLog',
    ]);

    await page.getByRole('tab', { name: 'Raw', exact: true }).click();
    await expect(page.getByTestId('raw-output')).toBeVisible();
    const beforeRaw = await renderCounts(page);
    await input.press('End');
    await input.pressSequentially('klmnopqrst');
    await expect(input).toHaveValue(`${initialPrompt}abcdefghijklmnopqrst`);
    const afterRaw = await renderCounts(page);
    expectUnchanged(beforeRaw, afterRaw, [
      'Stage',
      'Inspector',
      'ExampleList',
      'RawOutput',
    ]);

    await page.getByRole('tab', { name: /Objects/ }).click();
    const beforeOutline = await renderCounts(page);
    await page.getByRole('button', { name: 'Outlines' }).click();
    // A real view change must reach the stage (the render after the toggle,
    // plus any renderer revision it triggers) — the instrument is not inert.
    await expect
      .poll(async () => (await renderCounts(page)).Stage)
      .toBeGreaterThan(beforeOutline.Stage ?? 0);
  });

  test('hides objects from the legend and re-renders without them', async ({
    page,
  }) => {
    await openFixture(page, 'two-objects');
    const canvas = page.getByTestId('media-canvas');
    await runReplay(page, 'completed');
    const withOverlay = await canvasPixel(canvas, 0.35, 0.5);
    await page.getByRole('button', { name: 'Show object 0' }).click();
    await page.getByRole('button', { name: 'Show object 1' }).click();
    await expect(page.getByRole('button', { name: 'Show all objects' })).toBeVisible();
    await expect(canvas).toHaveAttribute('data-revision', '2');
    await expect
      .poll(async () => pixelDelta(await canvasPixel(canvas, 0.35, 0.5), withOverlay))
      .toBeGreaterThan(20);
    await page.getByRole('button', { name: 'Show all objects' }).click();
    await expect
      .poll(async () => pixelDelta(await canvasPixel(canvas, 0.35, 0.5), withOverlay))
      .toBeLessThan(4);
    await page.getByRole('button', { name: 'Overlay' }).click();
    await expect(canvas).not.toHaveAttribute('data-revision', /.+/);
  });

  test('draws mask outlines and drops them when the switch is off', async ({
    page,
  }) => {
    await openFixture(page, 'two-objects');
    const canvas = page.getByTestId('media-canvas');
    await runReplay(page, 'completed');
    // Every toggle repaints asynchronously; wait for the paint that follows
    // the click before sampling the canvas, so a slow runner cannot sample a
    // stale frame.
    const paintAfter = async (action: () => Promise<void>) => {
      const before = Number(await canvas.getAttribute('data-paint'));
      await action();
      await expect
        .poll(async () => Number(await canvas.getAttribute('data-paint')))
        .toBeGreaterThan(before);
      await expect(canvas).toHaveAttribute('data-revision', '2');
    };
    // Boxes off leaves the mask contour as the only stroked geometry.
    const boxes = page.getByRole('button', { name: 'Boxes' });
    await paintAfter(() => boxes.click());
    await expect(boxes).toHaveAttribute('aria-pressed', 'false');
    const outlined = await canvasBytes(canvas);

    const outlines = page.getByRole('button', { name: 'Outlines' });
    await expect(outlines).toHaveAttribute('aria-pressed', 'true');
    await paintAfter(() => outlines.click());
    await expect(outlines).toHaveAttribute('aria-pressed', 'false');
    expect(changedPixels(await canvasBytes(canvas), outlined)).toBeGreaterThan(200);

    await paintAfter(() => outlines.click());
    await expect(outlines).toHaveAttribute('aria-pressed', 'true');
    expect(changedPixels(await canvasBytes(canvas), outlined)).toBe(0);
  });

  test('surfaces recoverable parser diagnostics in the records panel', async ({
    page,
  }) => {
    await openFixture(page, 'fragmented-diagnostic');
    await runReplay(page, 'completed');
    await page.getByRole('tab', { name: /Records/ }).click();
    await expect(page.getByText(/parser diagnostic/)).toBeVisible();
  });

  test.describe('terminal outcomes', () => {
    for (const [fixture, status] of [
      ['incomplete', 'incomplete'],
      ['refusal', 'refused'],
      ['failure', 'failed'],
    ] as const) {
      test(`reports ${status}`, async ({ page }) => {
        await openFixture(page, fixture);
        await runReplay(page, status);
      });
    }
  });

  test('keeps cancellation distinct from terminal failure', async ({ page }) => {
    await openFixture(page, 'two-objects');
    await page.getByRole('button', { name: 'Run replay', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Replaying…', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByTestId('run-status')).toContainText('cancelled');
  });

  test('round-trips fixture, panel, and overlay through the URL', async ({ page }) => {
    await page.goto('/?fixture=two-objects&panel=stream&overlay=0');
    await expect(page.getByRole('tab', { name: /Stream/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: /Objects/ }).click();
    await expect(page.getByRole('button', { name: 'Overlay' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.getByRole('tab', { name: 'Raw' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('panel')).toBe('raw');
    expect(new URL(page.url()).searchParams.get('fixture')).toBe('two-objects');
  });
});

test.describe('live relay', () => {
  test('selects, filters, persists, and sends a model', async ({ page }) => {
    const relay = await mockLive(page);
    await page.goto('/?example=truck');

    const typeahead = page.getByTestId('model-typeahead');
    await expect(typeahead).toContainText('configured-model');
    await expect(page.locator('.app__brand')).toContainText('configured-model');
    await typeahead.getByRole('button', { name: 'configured-model' }).click();
    const input = page.getByRole('combobox', { name: 'Model' });
    await input.fill('sam-3');
    await expect(
      page.getByRole('option', { name: 'sam-3.1', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('option', { name: 'alpha-model', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('option', { name: 'sam-3.1', exact: true }).click();

    await expect(typeahead).toContainText('sam-3.1');
    await expect(page.locator('.app__brand')).toContainText('sam-3.1');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('model'))
      .toBe('sam-3.1');

    const segment = page.getByRole('button', { name: 'Segment', exact: true });
    await expect(segment).toBeEnabled({ timeout: 15_000 });
    await segment.click();
    await expect(page.getByTestId('run-status')).toContainText('completed');
    expect(relay.responseBodies.at(-1)).toContain('name="model"');
    expect(relay.responseBodies.at(-1)).toContain('sam-3.1');
  });

  test('shows current curl and TypeScript examples for live and fixture media', async ({
    page,
  }) => {
    await mockLive(page);
    for (const [url, prompt] of [
      ['/?example=truck', 'wheel'],
      ['/?fixture=two-objects', 'bench objects'],
    ] as const) {
      await page.goto(url);
      const code = page.getByRole('button', { name: 'Code', exact: true });
      await expect(code).toBeEnabled({ timeout: 15_000 });
      await code.click();
      const dialog = page.getByRole('dialog', { name: 'Request code' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('code-example')).toContainText(
        'configured-model',
      );
      await expect(dialog.getByTestId('code-example')).toContainText(prompt);
      await dialog.getByRole('tab', { name: 'TypeScript' }).click();
      await expect(dialog.getByTestId('code-example')).toContainText(
        '@meta-sam/parser',
      );
      await expect(dialog.getByTestId('code-example')).toContainText(
        'configured-model',
      );
      await expect(dialog.getByTestId('code-example')).toContainText(prompt);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });

  test('sends multipart prompt and media for an uploaded image and renders the stream', async ({
    page,
  }) => {
    let contentType: string | null = null;
    let body: string | null = null;
    await mockLive(page, (request) => {
      contentType = request.headers()['content-type'] ?? null;
      body = request.postData();
    });
    await page.goto('/');
    await expect(page.getByText(/configured-model via sam.example.test/)).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'live-sample.png',
      mimeType: 'image/png',
      buffer: PNG_PIXEL,
    });
    await expect(page.locator('.rail__current')).toContainText('live-sample.png');
    const prompt = page.getByRole('textbox', { name: 'Noun phrase' });
    await prompt.fill('live rectangular objects');
    const segment = page.getByRole('button', { name: 'Segment', exact: true });
    await expect(segment).toBeEnabled();
    await segment.click();
    await expect(page.getByTestId('run-status')).toContainText('completed');
    await expect(page.getByTestId('media-canvas')).toHaveAttribute(
      'data-revision',
      '2',
    );
    await expect(page.getByRole('tab', { name: 'Objects (2)' })).toBeVisible();
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('name="prompt"');
    expect(body).toContain('live rectangular objects');
    expect(body).toContain('name="model"');
    expect(body).toContain('configured-model');
    expect(body).toContain('name="media"; filename="live-sample.png"');
    expect(body).not.toContain('apiKey');
    expect(new URL(page.url()).searchParams.get('prompt')).toBe(
      'live rectangular objects',
    );
  });

  test('uploads an example video once and reuses the handle for a second run', async ({
    page,
  }) => {
    const relay = await mockLive(page, undefined, [
      {
        type: 'response.output_text.delta',
        ...LANE,
        delta:
          '<0f>0<|box;x1=10;y1=10;x2=20;y2=20;w=1280;h=720|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n',
      },
      { type: 'response.completed' },
    ]);
    await page.goto('/?example=bedroom');
    await expect(page.getByTestId('video-frame-count')).toContainText('frame 0 / 199', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('upload-status')).toContainText('video ready', {
      timeout: 30_000,
    });
    const segment = page.getByRole('button', { name: 'Segment', exact: true });
    await expect(segment).toBeEnabled({ timeout: 30_000 });

    await segment.click();
    await expect(page.getByTestId('run-status')).toContainText(/completed|incomplete/, {
      timeout: 30_000,
    });
    await expect(page.getByRole('tab', { name: 'Objects (1)' })).toBeVisible();

    await expect(segment).toBeEnabled({ timeout: 30_000 });
    await segment.click();
    await expect.poll(() => relay.responseBodies.length).toBe(2);
    await expect(page.getByTestId('run-status')).toContainText(/completed|incomplete/, {
      timeout: 30_000,
    });

    expect(relay.fileUploads).toBe(1);
    for (const body of relay.responseBodies) {
      expect(body).toContain('name="file_id"');
      expect(body).toContain('file-playground123');
      expect(body).toContain('name="model"');
      expect(body).toContain('configured-model');
      expect(body).not.toContain('name="media"');
    }
  });

  test('re-uploads once and retries when the relay reports a stale handle', async ({
    page,
  }) => {
    const relay = await mockLive(page, undefined, [
      {
        type: 'response.output_text.delta',
        ...LANE,
        delta:
          '<0f>0<|box;x1=10;y1=10;x2=20;y2=20;w=1280;h=720|><|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n',
      },
      { type: 'response.completed' },
    ]);
    let rejectedOnce = false;
    await page.route('**/api/responses', async (route) => {
      if (rejectedOnce) return await route.fallback();
      rejectedOnce = true;
      relay.responseBodies.push(route.request().postData() ?? '');
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'stale_file_handle',
            message: 'The uploaded video is no longer available. Upload it again.',
          },
        }),
      });
    });

    await page.goto('/?example=bedroom');
    await expect(page.getByTestId('upload-status')).toContainText('video ready', {
      timeout: 30_000,
    });
    const segment = page.getByRole('button', { name: 'Segment', exact: true });
    await expect(segment).toBeEnabled({ timeout: 30_000 });
    await segment.click();
    await expect(page.getByTestId('run-status')).toContainText(/completed|incomplete/, {
      timeout: 30_000,
    });
    expect(relay.fileUploads).toBe(2);
    expect(relay.responseBodies).toHaveLength(2);
  });

  test('rejects unsupported uploads before any request', async ({ page }) => {
    let requests = 0;
    await mockLive(page, () => {
      requests += 1;
    });
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'vector.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    await expect(
      page.getByText(/"vector.svg" is not an accepted file type/).first(),
    ).toBeVisible();
    await expect(page.locator('.rail__current')).toHaveCount(0);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      buffer: MP4_HEADER,
    });
    await expect(page.locator('.rail__current')).toContainText('clip.mp4');
    expect(requests).toBe(0);
  });
});

test.describe('video fixture', () => {
  test('plays packet-exact frames with one Canvas and follows the streamed frame', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.goto('/?fixture=video-quick');
    const canvas = page.getByRole('img', {
      name: 'Video segmentation visualization for Quick VP9 + Opus',
    });
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId('video-frame-count')).toContainText('frame 0 / 7');
    await expect(page.locator('video')).toHaveCount(0);
    // The stage owns the only canvas; example thumbnails are plain images.
    await expect(page.locator('.stage canvas')).toHaveCount(1);

    await runReplay(page, 'completed');
    await expect(page.getByTestId('video-frame-count')).not.toContainText('frame 0 /');
    await page.getByRole('button', { name: 'Previous frame' }).click();
    const readout = await page.getByTestId('video-frame-count').innerText();
    const frame = Number(/frame (\d+)/.exec(readout)?.[1]);
    await page.getByRole('button', { name: 'Next frame' }).click();
    await expect(page.getByTestId('video-frame-count')).toContainText(
      `frame ${frame + 1} /`,
    );

    await page.getByRole('tab', { name: /Records/ }).click();
    await expect(
      page.getByRole('switch', { name: 'Current frame only' }),
    ).toBeChecked();
    await expect(page.getByText(/^f\d+ · /).first()).toBeVisible();

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Pause', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    expect(pageErrors).toEqual([]);
  });

  test('keeps a single React runtime when switching between image and video', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.goto('/?example=truck');
    await expect(page.getByTestId('media-canvas')).toBeVisible();
    await page.getByRole('button', { name: /^Bedroom/ }).click();
    await expect(page.getByTestId('video-frame-count')).toContainText('frame 0 / 199', {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /^Truck/ }).click();
    await expect(page.getByTestId('media-canvas')).toBeVisible();
    await expect(page.getByTestId('video-frame-count')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('examples rail', () => {
  const rows = ['Bedroom', 'Truck', 'Groceries'];

  test('shows a decoded thumbnail for every example', async ({ page }) => {
    await page.goto('/');
    const thumbnails = page.locator('.example-thumb__image');
    // Video posters are extracted one at a time from the media itself.
    await expect(thumbnails).toHaveCount(rows.length, { timeout: 60_000 });
    const sizes = await thumbnails.evaluateAll((images) =>
      images.map((image) => [
        (image as HTMLImageElement).naturalWidth,
        (image as HTMLImageElement).naturalHeight,
      ]),
    );
    expect(sizes).toHaveLength(rows.length);
    for (const [width, height] of sizes) {
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
    for (const name of rows) {
      await expect(
        page.getByRole('button', { name: new RegExp(`^${name}`) }),
      ).toBeVisible();
    }
    await expect(page.locator('video')).toHaveCount(0);
  });

  test('plays a muted preview while a video row is hovered', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.example-thumb__image').first()).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('button', { name: /^Bedroom/ }).hover();
    const preview = page.getByTestId('example-preview-bedroom');
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveJSProperty('muted', true);
    await expect
      .poll(
        async () => await preview.evaluate((video: HTMLVideoElement) => !video.paused),
        {
          timeout: 20_000,
        },
      )
      .toBe(true);
    await expect(page.locator('video')).toHaveCount(1);

    await page.getByRole('button', { name: /^Truck/ }).hover();
    await expect
      .poll(async () =>
        preview.evaluate((video: HTMLVideoElement) => ({
          paused: video.paused,
          time: video.currentTime,
        })),
      )
      .toEqual({ paused: true, time: 0 });
  });

  test('does not autoplay a preview under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('.example-thumb__image').first()).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('button', { name: /^Bedroom/ }).hover();
    await page.waitForTimeout(500);
    await expect(page.locator('video')).toHaveCount(0);
  });
});

test.describe('virtualized inspector panels', () => {
  const BULK_DELTAS = 3_000;

  function bulkEvents(): readonly object[] {
    const events: object[] = [];
    let text = '';
    for (let index = 0; index < BULK_DELTAS; index += 1) {
      const delta = `line ${index} of the streamed output ${'.'.repeat(40)}\n`;
      text += delta;
      events.push({ type: 'response.output_text.delta', ...LANE, delta });
    }
    events.push({ type: 'response.output_text.done', ...LANE, text });
    events.push({ type: 'response.completed' });
    return events;
  }

  test('renders a window of rows for a long run and follows the newest', async ({
    page,
  }) => {
    await mockLive(page, undefined, bulkEvents());
    await page.goto('/?example=truck&panel=stream');
    const segment = page.getByRole('button', { name: 'Segment', exact: true });
    await expect(segment).toBeEnabled({ timeout: 30_000 });
    await segment.click();
    await expect(page.getByTestId('run-status')).toContainText('completed', {
      timeout: 120_000,
    });

    // 3000 deltas plus the terminal event, of which only a window is in the DOM.
    const list = page.getByRole('list', { name: 'Stream events' });
    const rows = list.locator('li');
    await expect(list).toHaveAttribute('data-total', String(BULK_DELTAS + 1));
    expect(await rows.count()).toBeLessThan(100);
    await expect(rows.last()).toContainText('response.completed');
    await expect(rows.last()).toHaveAttribute('aria-posinset', String(BULK_DELTAS + 1));
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toHaveCount(0);

    await page.locator('.stream-log__rows').evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(jump).toBeVisible();
    await expect(rows.first()).toHaveAttribute('data-index', '0');
    expect(await rows.count()).toBeLessThan(100);

    await jump.click();
    await expect(jump).toHaveCount(0);
    await expect(rows.last()).toContainText('response.completed');

    await page.getByRole('tab', { name: 'Raw' }).click();
    const raw = page.getByTestId('raw-output');
    await expect(raw).toContainText('line 0 of the streamed output');
    await expect(raw.getByRole('list')).toHaveAttribute(
      'data-total',
      String(BULK_DELTAS),
    );
    expect(await raw.locator('li').count()).toBeLessThan(100);

    // Switching away and back re-mounts the panel cleanly.
    await page.getByRole('tab', { name: /Objects/ }).click();
    await expect(page.getByTestId('raw-output')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Raw' }).click();
    await expect(page.getByTestId('raw-output')).toContainText('line 0 of the');
  });

  test('keeps both panels empty-stated before a run', async ({ page }) => {
    await page.goto('/?example=truck&panel=stream');
    await expect(page.getByText('No stream events')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Stream events' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Raw' }).click();
    await expect(page.getByText('No output yet')).toBeVisible();
    await expect(page.getByTestId('raw-output')).toHaveCount(0);
  });
});

test.describe('visual baselines', () => {
  /**
   * Fonts and example posters arrive asynchronously; a screenshot taken before
   * they settle differs from the baseline by a few hundred pixels on a slow
   * runner. Wait for both before comparing.
   */
  async function settleVisuals(page: Page): Promise<void> {
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLImageElement>(
              '[aria-label="Examples"] img',
            ),
          ].every((image) => image.complete && image.naturalWidth > 0),
        ),
      )
      .toBe(true);
    const posters = page.locator('[aria-label="Examples"] img[src^="data:"]');
    await expect(posters).toHaveCount(1);
  }

  test('image inspector in light and dark', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page, 'two-objects');
    await runReplay(page, 'completed');
    await settleVisuals(page);
    await expect(page).toHaveScreenshot('surface-image-light.png', {
      animations: 'disabled',
    });
    await page.getByRole('radio', { name: 'dark' }).click();
    await expect(page).toHaveScreenshot('surface-image-dark.png', {
      animations: 'disabled',
    });
  });

  test('video transport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?fixture=video-quick&panel=records');
    await expect(page.getByTestId('video-frame-count')).toContainText('frame 0 / 7');
    await runReplay(page, 'completed');
    await settleVisuals(page);
    await expect(page).toHaveScreenshot('surface-video.png', {
      animations: 'disabled',
    });
  });

  test('narrow layout stacks the rail, stage, and inspector', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 1200 });
    await openFixture(page, 'two-objects');
    await runReplay(page, 'completed');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await settleVisuals(page);
    // The full-page narrow capture is text-dense (~630k px); glyph
    // anti-aliasing differs by a few hundred pixels between Linux font
    // stacks, which the default 0.1% budget sits right on. Layout regressions
    // move thousands of pixels and still trip this.
    await expect(page).toHaveScreenshot('surface-mobile.png', {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.005,
    });
  });
});
