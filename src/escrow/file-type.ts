export type WaybillMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

const SIGNATURES: [WaybillMimeType, number[]][] = [
  ['application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
];

/** Detects the type from magic bytes; the client-sent mimetype is not trusted. */
export function sniffWaybillType(data: Buffer): WaybillMimeType | null {
  for (const [type, signature] of SIGNATURES) {
    if (signature.every((byte, i) => data[i] === byte)) return type;
  }
  return null;
}
