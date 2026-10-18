// SPDX-License-Identifier: MIT
// One optically centered gear for the app's settings controls.
function makeSettingsPath() {
  const teeth = Array.from({ length: 8 }, (_, tooth) =>
    [-13, -5, 5, 13].map((offset, corner) => {
      const angle = ((tooth * 45 + offset - 90) * Math.PI) / 180;
      const radius = corner === 0 || corner === 3 ? 7.5 : 9.5;
      return `${(12 + Math.cos(angle) * radius).toFixed(2)} ${(12 + Math.sin(angle) * radius).toFixed(2)}`;
    }),
  ).flat();
  return `M${teeth.join("L")}ZM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z`;
}
export const settingsPath = /* @__PURE__ */ makeSettingsPath();
