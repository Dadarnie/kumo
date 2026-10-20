// SPDX-License-Identifier: MIT
import { musicMode } from "../icons/glyphs";
import { mimoIcon } from "../icons/render";

/** Local vector brand marks selected from the existing normalized source ID.
 * No icon downloads, app probing, or second media subscription. */
export function mediaSource(source: string | null): {
  name: string;
  logo: SVGSVGElement;
  id: string;
} {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: string, attrs: Record<string, string>) => {
    const child = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    svg.append(child);
  };
  if (/spotify/i.test(source ?? "")) {
    shape("circle", { cx: "12", cy: "12", r: "11", fill: "#1ed760" });
    shape("path", {
      d: "M6 9c4-1.2 8-1 12 1M7 12.5c3.2-.8 6.6-.5 9.5 1M8 16c2.4-.6 4.8-.3 7 .8",
      fill: "none",
      stroke: "#092516",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
    });
    return { name: "Spotify", logo: svg, id: "spotify" };
  }
  if (/chrome/i.test(source ?? "")) {
    shape("circle", { cx: "12", cy: "12", r: "11", fill: "#ea4335" });
    shape("path", { d: "M12 6.5h9.526A11 11 0 0 1 12 23l4.763-8.25A5.5 5.5 0 0 0 12 6.5Z", fill: "#fbbc05" });
    shape("path", { d: "M12 23A11 11 0 0 1 2.474 6.5l4.763 8.25a5.5 5.5 0 0 0 9.526 0Z", fill: "#34a853" });
    shape("circle", {
      cx: "12",
      cy: "12",
      r: "5",
      fill: "#4285f4",
      stroke: "#f2f5fa",
      "stroke-width": "1.4",
    });
    return { name: "Chrome", logo: svg, id: "chrome" };
  }
  if (/msedge|microsoftedge/i.test(source ?? "")) {
    shape("path", {
      d: "M22 14c0 5-4 9-10 9C5 23 1 18 1 12 1 5 6 1 12 1c6 0 10 4 10 10-2-3-4-4-7-4-4 0-6 3-6 6 0 3 2 5 6 5 3 0 5-1 7-4Z",
      fill: "#22b8ac",
    });
    shape("path", {
      d: "M1 12c0 7 5 11 11 11 5 0 9-3 10-7-2 2-5 3-8 3-5 0-8-2-8-5 0-4 4-6 8-5-2-2-5-3-8-2-3 1-5 3-5 5Z",
      fill: "#258be9",
    });
    return { name: "Microsoft Edge", logo: svg, id: "edge" };
  }
  if (/vlc|videolan/i.test(source ?? "")) {
    shape("path", { d: "m12 2 8 19H4Z", fill: "#ef922d" });
    shape("path", { d: "M9.5 8h5l1.4 3H8.1Zm-3.3 8h11.6l1.3 3H4.9Z", fill: "#fff4e8" });
    return { name: "VLC", logo: svg, id: "vlc" };
  }
  // Firefox-family browsers (Zen, Firefox) report a 16-digit install hash.
  if (/^[0-9a-f]{16}$/i.test(source ?? "")) return { name: "Browser", logo: mimoIcon(musicMode, 16), id: "browser" };
  // Store apps report Package_hash!App; the part after "!" is the app name.
  const packaged = source?.match(/!([A-Za-z0-9.]+)$/)?.[1];
  const name = packaged ? packaged.replace(/^App$/, "")
    : source && !/[!_\\/]/.test(source) ? source.replace(/\.exe$/i, "") : "";
  return { name, logo: mimoIcon(musicMode, 16), id: "generic" };
}
