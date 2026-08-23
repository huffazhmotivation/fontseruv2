let counter = 0;

/** Fast, collision-safe-enough id for in-session objects (nodes, contours). */
export function shortId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}
