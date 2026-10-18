// SPDX-License-Identifier: MIT
/** Match a canvas backing buffer to Windows DPI without changing CSS geometry. */
export function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): number {
  const dpr = window.devicePixelRatio || 1;
  const pixelsWide = Math.max(1, Math.round(width * dpr));
  const pixelsHigh = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
  if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
  const cssWidth = `${width}px`;
  const cssHeight = `${height}px`;
  if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
  if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
  return dpr;
}
