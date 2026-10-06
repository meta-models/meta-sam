/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { objectColor } from '@meta-sam/graphics';
import { useEffect, useRef, useState } from 'react';

import {
  boxFromCorners,
  clampPoint,
  MIN_BOX_DRAG_PX,
  type ObjectPromptState,
  type PixelBox,
  type PromptPoint,
} from './object-prompts';

export interface PromptOverlayProps {
  readonly prompts: ObjectPromptState;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /**
   * The frame the stage shows; images are always frame 0. New prompts go on
   * this frame, and only this frame's prompts are drawn.
   */
  readonly frameIndex: number;
  /** `false` while a run streams or a video plays. */
  readonly isInteractive: boolean;
  readonly onBox: (frameIndex: number, box: PixelBox) => void;
  readonly onPoint: (frameIndex: number, point: PromptPoint) => void;
}

interface Drag {
  readonly pointerId: number;
  /** A right-button press always adds a negative point. */
  readonly button: number;
  readonly startClient: { readonly x: number; readonly y: number };
  readonly currentClient: { readonly x: number; readonly y: number };
  readonly start: { readonly x: number; readonly y: number };
  readonly current: { readonly x: number; readonly y: number };
}

function dragDistance(drag: Drag): number {
  return Math.hypot(
    drag.currentClient.x - drag.startClient.x,
    drag.currentClient.y - drag.startClient.y,
  );
}

/**
 * Draws object prompts over the stage in source-pixel coordinates and turns
 * pointer input into prompts: a drag draws the selected object's box, a click
 * adds a point, and an Option-click or right-click adds a negative point. The
 * SVG view box is the source frame with `meet` fitting, which matches how the
 * stage fits the media, so the screen-to-source mapping is the SVG's own
 * coordinate transform.
 */
export function PromptOverlay({
  prompts,
  sourceWidth,
  sourceHeight,
  frameIndex,
  isInteractive,
  onBox,
  onPoint,
}: PromptOverlayProps): React.JSX.Element | null {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Source units per screen pixel, so handles keep a constant on-screen size.
  const [unit, setUnit] = useState(1);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const update = () => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setUnit(Math.max(sourceWidth / rect.width, sourceHeight / rect.height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [sourceHeight, sourceWidth]);

  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const canDraw = isInteractive;

  const toSource = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (svg === null || svg === undefined || matrix === null || matrix === undefined) {
      return null;
    }
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!canDraw || (event.button !== 0 && event.button !== 2)) return;
    const start = toSource(event.clientX, event.clientY);
    if (start === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const client = { x: event.clientX, y: event.clientY };
    setDrag({
      pointerId: event.pointerId,
      button: event.button,
      startClient: client,
      currentClient: client,
      start,
      current: start,
    });
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const current = toSource(event.clientX, event.clientY);
    if (current !== null) {
      setDrag({
        ...drag,
        current,
        currentClient: { x: event.clientX, y: event.clientY },
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    setDrag(null);
    const end = toSource(event.clientX, event.clientY) ?? drag.current;
    const released = {
      ...drag,
      current: end,
      currentClient: { x: event.clientX, y: event.clientY },
    };
    if (drag.button === 0 && dragDistance(released) >= MIN_BOX_DRAG_PX) {
      onBox(frameIndex, boxFromCorners(drag.start, end, sourceWidth, sourceHeight));
      return;
    }
    const negative = prompts.tool === 'negative' || event.altKey || drag.button === 2;
    const point = clampPoint(drag.start.x, drag.start.y, sourceWidth, sourceHeight);
    onPoint(frameIndex, { ...point, positive: !negative });
  };

  const draft =
    drag !== null && drag.button === 0 && dragDistance(drag) >= MIN_BOX_DRAG_PX
      ? boxFromCorners(drag.start, drag.current, sourceWidth, sourceHeight)
      : null;
  const draftColor = objectColor(String(prompts.selectedId ?? nextId(prompts)));
  const radius = 6 * unit;
  const stroke = 2 * unit;
  const hint =
    prompts.tool === 'positive'
      ? 'Drag to draw a box around the object. Click to add a positive point; Option-click or right-click to add a negative point'
      : 'Drag to draw a box around the object. Click to add a negative point';

  return (
    <div className="prompt-layer">
      <svg
        ref={svgRef}
        className={`prompt-overlay${canDraw ? ' prompt-overlay--active' : ''}`}
        viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
        preserveAspectRatio="xMidYMid meet"
        role="application"
        aria-label={`Prompt canvas. ${hint}.`}
        data-testid="prompt-overlay"
        data-tool={prompts.tool}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onContextMenu={(event) => {
          if (canDraw) event.preventDefault();
        }}
      >
        {prompts.objects.map((object) => {
          const entry = object.frames.find((frame) => frame.frameIndex === frameIndex);
          if (entry === undefined) return null;
          const color = objectColor(String(object.id));
          const selected = object.id === prompts.selectedId;
          return (
            <g key={object.id} data-object-id={object.id}>
              {entry.box === null ? null : (
                <rect
                  x={entry.box.x1}
                  y={entry.box.y1}
                  width={entry.box.x2 - entry.box.x1 + 1}
                  height={entry.box.y2 - entry.box.y1 + 1}
                  fill={color}
                  fillOpacity={0.08}
                  stroke={color}
                  strokeWidth={selected ? stroke * 1.5 : stroke}
                  strokeDasharray={`${6 * unit} ${4 * unit}`}
                  data-testid="prompt-box"
                />
              )}
              {entry.points.map((point, index) => (
                <g
                  key={index}
                  transform={`translate(${point.x + 0.5} ${point.y + 0.5})`}
                  data-testid={point.positive ? 'prompt-positive' : 'prompt-negative'}
                >
                  <circle
                    r={radius}
                    fill={point.positive ? color : '#ffffff'}
                    stroke={point.positive ? '#ffffff' : color}
                    strokeWidth={stroke}
                  />
                  <path
                    d={
                      point.positive
                        ? `M ${-radius * 0.5} 0 H ${radius * 0.5} M 0 ${-radius * 0.5} V ${radius * 0.5}`
                        : `M ${-radius * 0.5} 0 H ${radius * 0.5}`
                    }
                    stroke={point.positive ? '#ffffff' : color}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                  />
                </g>
              ))}
            </g>
          );
        })}
        {draft === null ? null : (
          <rect
            x={draft.x1}
            y={draft.y1}
            width={draft.x2 - draft.x1 + 1}
            height={draft.y2 - draft.y1 + 1}
            fill="none"
            stroke={draftColor}
            strokeWidth={stroke}
            strokeDasharray={`${6 * unit} ${4 * unit}`}
          />
        )}
      </svg>
    </div>
  );
}

function nextId(prompts: ObjectPromptState): number {
  return (
    prompts.objects.reduce((highest, object) => Math.max(highest, object.id), 0) + 1
  );
}
