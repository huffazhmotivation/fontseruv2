export function unicodeHex(codePoint: number): string {
  return "U+" + codePoint.toString(16).toUpperCase().padStart(4, "0");
}
