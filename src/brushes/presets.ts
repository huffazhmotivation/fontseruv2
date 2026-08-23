import type { BrushPreset, BrushType } from "@/types/brush";

/**
 * All presets share one engine (`brushes/strokeToOutline.ts`). What makes
 * them behave differently is real geometry, not cosmetic labels:
 *  - `roundness` < 1 flattens the nib into an ellipse (marker/calligraphic).
 *  - `angle` fixes that ellipse's rotation, independent of stroke direction
 *    (a broad-nib calligraphy effect).
 *  - `pressureEnabled` + `minSize`/`maxSize` decide whether pointer
 *    pressure (or a synthetic velocity-based substitute for mice) drives
 *    width at all.
 *  - `taperStart`/`taperEnd` shrink the nib toward the stroke's ends
 *    regardless of pressure.
 */
export const BRUSH_PRESETS: Record<BrushType, BrushPreset> = {
  round: {
    id: "round",
    label: "Basic Round",
    description: "Circular nib, pressure-sensitive width.",
    settings: {
      size: 26,
      minSize: 8,
      maxSize: 26,
      opacity: 1,
      spacing: 4,
      smoothing: 0.5,
      // Brush Stabilizer defaults on, moderate strength: smooths live
      // pointer position (mouse/stylus/pen, Normal + Sketch Mode alike)
      // without adding perceptible lag, and never touches pressure — see
      // stabilizeBrushPoint()/pressureFor() in useBrushTool.ts.
      stabilizer: 0.35,
      roundness: 1,
      angle: 0,
      taperStart: 0.15,
      taperEnd: 0.2,
      pressureEnabled: true,
    },
  },
  monoline: {
    id: "monoline",
    label: "Monoline",
    description: "Constant width, no pressure response.",
    settings: {
      size: 18,
      minSize: 18,
      maxSize: 18,
      opacity: 1,
      spacing: 4,
      smoothing: 0.3,
      stabilizer: 0.3,
      roundness: 1,
      angle: 0,
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
    },
  },
  marker: {
    id: "marker",
    label: "Marker",
    description: "Broad, near-uniform felt-tip nib held at a shallow angle — soft directional width, not pressure.",
    settings: {
      size: 34,
      minSize: 34,
      maxSize: 34,
      opacity: 0.88,
      spacing: 6,
      smoothing: 0.22,
      stabilizer: 0.3,
      // A wide, only mildly flattened ellipse: width stays fairly broad in
      // most directions, the way a chisel-tip marker reads on paper — the
      // opposite of Calligraphic's sharp, high-contrast nib below.
      roundness: 0.34,
      angle: 8,
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
    },
  },
  calligraphic: {
    id: "calligraphic",
    label: "Calligraphic",
    description: "Thin, fixed-angle broad-edge pen nib — strong thick/thin contrast from stroke direction alone.",
    settings: {
      size: 30,
      minSize: 30,
      maxSize: 30,
      opacity: 1,
      spacing: 4,
      smoothing: 0.4,
      stabilizer: 0.3,
      // A near-flat ellipse at the classic 45° broad-nib angle: strokes with
      // the pen swing thin, strokes across it go full width — dramatic
      // contrast that Marker deliberately avoids.
      roundness: 0.08,
      angle: 45,
      taperStart: 0.06,
      taperEnd: 0.06,
      pressureEnabled: false,
    },
  },
  pencil: {
    id: "pencil",
    label: "Pencil",
    description: "Thin graphite line with fine grain — subtle jitter and low smoothing keep the hand tremor.",
    settings: {
      size: 9,
      minSize: 3,
      maxSize: 9,
      opacity: 0.82,
      spacing: 2,
      smoothing: 0.1,
      // Kept low relative to the other presets: Pencil's whole character is
      // the hand-tremor grain (jitter below), so only light stabilization
      // is applied to avoid smoothing that texture away.
      stabilizer: 0.15,
      roundness: 0.9,
      angle: 0,
      taperStart: 0.05,
      taperEnd: 0.05,
      pressureEnabled: true,
      // Fine, low-amplitude grain — a fraction of Grunge's jitter below —
      // reads as graphite texture rather than a rough distressed edge.
      jitter: 0.14,
    },
  },
  pressureTaper: {
    id: "pressureTaper",
    label: "Pressure Taper",
    description: "Wide dynamic range with strong tapered ends — brush-lettering swashes.",
    settings: {
      size: 30,
      minSize: 2,
      maxSize: 38,
      opacity: 1,
      spacing: 3,
      smoothing: 0.6,
      stabilizer: 0.35,
      roundness: 1,
      angle: 0,
      taperStart: 0.4,
      taperEnd: 0.4,
      pressureEnabled: true,
    },
  },
  grunge: {
    id: "grunge",
    label: "Grunge",
    description: "Rough, heavily distressed edge — still a real closed vector outline underneath, not a raster texture.",
    settings: {
      size: 32,
      minSize: 12,
      maxSize: 38,
      opacity: 0.92,
      // Denser resampling than any other brush: more samples means more
      // high-frequency edge noise, which is what actually reads as "rough"
      // rather than a wobbly-but-smooth line.
      spacing: 1,
      smoothing: 0.04,
      // Kept low, same reasoning as Pencil: heavy live stabilization would
      // fight the deliberately noisy, distressed edge this brush is for.
      stabilizer: 0.1,
      roundness: 0.62,
      angle: 0,
      taperStart: 0.12,
      taperEnd: 0.18,
      pressureEnabled: true,
      jitter: 0.85,
    },
  },
  pixel: {
    id: "pixel",
    label: "Pixel",
    description: "True grid-cell blocks, not a smoothed line — the ONLY brush with grid snapping (see gridSnap docs).",
    settings: {
      size: 24,
      minSize: 24,
      maxSize: 24,
      opacity: 1,
      spacing: 1,
      smoothing: 0,
      // No stabilizer here on purpose: useBrushTool's pixelSnap path grid-
      // snaps every point directly and skips stabilizeBrushPoint() entirely,
      // so a value here would be inert anyway (see pointerDown/pointerMove).
      roundness: 1,
      angle: 0,
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
      // The ONLY preset with gridSnap on. Its outline is built entirely
      // differently from every other brush — see pixelBlockOutline() in
      // strokeToOutline.ts — and switching to any other preset clears this
      // flag immediately (see setBrush() in glyph/store.ts).
      gridSnap: true,
    },
  },
};

export const BRUSH_ORDER: BrushType[] = [
  "monoline",
  "marker",
  "calligraphic",
  "pencil",
  "grunge",
  "pixel",
];
