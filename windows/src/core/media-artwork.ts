// SPDX-License-Identifier: MIT
// One current image, shared by every media surface. The native raster bytes are
// unchanged; object URLs give the browser an explicit retirement boundary.
const MAX_BYTES = 4 * 1024 * 1024; // Match windows/media_artwork.rs.
const MAX_BASE64_LENGTH = Math.ceil(MAX_BYTES / 3) * 4;
const RASTER = /^data:image\/(png|jpeg|webp|gif);base64,/;

export class CurrentArtwork {
  private source: string | null = null;
  private url: string | null = null;

  replace(source: string | null): { url: string | null; release: () => void } {
    // Store snapshots can be reapplied by a confirmed action. Never treat an
    // arbitrary blob URL from a provider as an owned artwork resource.
    if (source === this.source || (this.url !== null && source === this.url))
      return { url: this.url, release: () => {} };
    const previous = this.url;
    let next: string | null = null;
    const match = source && RASTER.exec(source);
    if (match && source.length - match[0].length <= MAX_BASE64_LENGTH) {
      try {
        const binary = atob(source.slice(match[0].length));
        if (binary.length > 0 && binary.length <= MAX_BYTES) {
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          next = URL.createObjectURL(new Blob([bytes], { type: `image/${match[1]}` }));
        }
      } catch {
        // Corrupt or unavailable images retain the existing artwork fallback.
      }
    }
    this.source = next ? source : null;
    this.url = next;
    let released = false;
    return {
      url: next,
      release: () => {
        if (released) return;
        released = true;
        if (previous) URL.revokeObjectURL(previous);
      },
    };
  }
}
