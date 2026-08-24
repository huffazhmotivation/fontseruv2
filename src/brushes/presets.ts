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
  rough: {
    id: "rough",
    label: "Rough",
    description: "Near-constant-width line like Monoline, with a few small irregular texture holes inside the stroke and a light, uneven grain along both edges.",
    settings: {
      size: 20,
      minSize: 20,
      maxSize: 20,
      opacity: 1,
      spacing: 3,
      smoothing: 0.35,
      stabilizer: 0.3,
      roundness: 1,
      angle: 0,
      // Flat-cut ends, same as Monoline (taper 0) — a tapered point at the
      // start/finish read as a stray, out-of-place spike on an otherwise
      // constant-width stroke.
      taperStart: 0,
      taperEnd: 0,
      pressureEnabled: false,
      // Denser, more varied scatter of counter-holes — see
      // roughBrushOutlineContours() in strokeToOutline.ts. Each is a real
      // vector counter (hole) per dot, not a raster texture, so it exports
      // cleanly into the font too.
      holeDensity: 3.2,
      holeSize: 0.18,
      // Fine, independent left/right edge grain (see the "rough" branch in
      // centerlineToOutline() in strokeToOutline.ts) — just enough to break
      // up the otherwise mechanically smooth outline, without turning into
      // Grunge's heavy spikes. Raise for a rougher edge, lower/0 for a
      // perfectly clean edge (holes only, the old look).
      jitter: 0.55,
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
  oilBrush: {
    id: "oilBrush",
    label: "Oil Brush",
    description: "Dry-brush drag: a smooth body with broad, torn scallops along the edge and frayed, breaking-up ends — like a loaded flat brush running low on paint.",
    settings: {
      size: 34,
      minSize: 34,
      maxSize: 34,
      opacity: 1,
      spacing: 4,
      // Kept close to a normal brush (unlike Grunge's near-zero smoothing):
      // Oil Brush wants a clean, coherent stroke body — the ragged look
      // comes entirely from the wide, low-frequency edge waves added in
      // strokeToOutline.ts (oilEdgeOffset()), not from a noisy centerline.
      smoothing: 0.35,
      stabilizer: 0.3,
      // A mildly flattened nib, like a real chisel/flat brush held nearly
      // flat to the page rather than Calligraphic's sharp broad-edge pen.
      roundness: 0.85,
      angle: 0,
      // Stronger than any other preset's taper, especially at the end: this
      // is what makes the stroke visibly run out of paint/lift off, echoing
      // a dry-brush pass rather than a clean pen stroke.
      taperStart: 0.14,
      taperEnd: 0.24,
      pressureEnabled: false,
      // Amplitude for the coherent (non-jittery) torn-edge waves — see
      // oilEdgeOffset() in strokeToOutline.ts. Distinct from Grunge's jitter:
      // this is smoothly interpolated per-lobe noise, which reads as broad
      // torn scallops rather than fine spiky noise.
      jitter: 0.5,
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
  "rough",
  "grunge",
  "oilBrush",
  "pixel",
];
