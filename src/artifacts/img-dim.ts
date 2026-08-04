/**
 * Tiny PNG/JPEG header parsers — format + pixel dimensions only, hand-rolled so image sizing
 * needs no dependency. Anything unparseable returns null (the caller refuses with a reason);
 * these never throw on hostile bytes.
 */

export interface ImageInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  contentType: 'image/png' | 'image/jpeg';
  extension: 'png' | 'jpeg';
}

const readU32BE = (b: Uint8Array, o: number): number => (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
const readU16BE = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  // PNG: 8-byte signature, then the IHDR chunk must come first (length 13, type 'IHDR').
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    const width = readU32BE(bytes, 16);
    const height = readU32BE(bytes, 20);
    if (width > 0 && height > 0 && width <= 30_000 && height <= 30_000) {
      return { format: 'png', width, height, contentType: 'image/png', extension: 'png' };
    }
    return null;
  }

  // JPEG: walk marker segments to the first SOF (baseline or progressive variants).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      // Fill bytes: any number of 0xFF may precede a marker (ITU T.81 B.1.1.2). Reading one as
      // the marker derails the walk and refuses a perfectly valid JPEG.
      while (bytes[o + 1] === 0xff) o += 1;
      const marker = bytes[o + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2; // standalone markers carry no length
        continue;
      }
      const len = readU16BE(bytes, o + 2);
      if (len < 2) return null;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        const height = readU16BE(bytes, o + 5);
        const width = readU16BE(bytes, o + 7);
        if (width > 0 && height > 0 && width <= 30_000 && height <= 30_000) {
          return { format: 'jpeg', width, height, contentType: 'image/jpeg', extension: 'jpeg' };
        }
        return null;
      }
      o += 2 + len;
    }
  }
  return null;
}
