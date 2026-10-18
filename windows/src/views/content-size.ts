// SPDX-License-Identifier: MIT
/** Measure intrinsic content without letting the current island height constrain it. */
export function naturalHeight(element: HTMLElement): number {
  if (!element.parentElement || !element.offsetWidth) return 0;
  const probe = element.cloneNode(true) as HTMLElement;
  probe.inert = true;
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "absolute", width: element.offsetWidth + "px", height: "auto",
    minHeight: "0", maxHeight: "none", visibility: "hidden", pointerEvents: "none",
  });
  element.parentElement.append(probe);
  const height = probe.offsetHeight;
  probe.remove();
  return height;
}
