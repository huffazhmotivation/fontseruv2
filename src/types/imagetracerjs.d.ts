/**
 * `imagetracerjs` ships as a plain UMD script with no TypeScript types and
 * no package.json "types"/"exports" field (main: imagetracer_v1.2.6.js).
 * This ambient declaration covers only the API surface this app actually
 * calls (imagedataToTracedata + its options/result shapes) so the Trace
 * Image feature can import it safely under `strict` mode without touching
 * the library itself.
 */
declare module "imagetracerjs" {
  /** One vectorized segment: a straight line ("L") or a quadratic curve ("Q"). */
  export interface TraceSegment {
    type: "L" | "Q";
    /** Segment start point. */
    x1: number;
    y1: number;
    /** Line: end point. Quadratic curve: control point. */
    x2: number;
    y2: number;
    /** Present only for "Q" segments — the curve's end point. */
    x3?: number;
    y3?: number;
  }

  /** One closed traced contour (outer shape or a counter/hole within one). */
  export interface TracePath {
    segments: TraceSegment[];
    boundingbox: [number, number, number, number];
    /** Indices, within the same color layer's path array, of hole paths that belong to this outer path. */
    holechildren: number[];
    isholepath: boolean;
  }

  export interface TracePaletteColor {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  export interface Tracedata {
    /** One entry per palette color; each entry is that color's list of closed paths. */
    layers: TracePath[][];
    palette: TracePaletteColor[];
    width: number;
    height: number;
  }

  export interface TraceOptions {
    corsenabled?: boolean;
    ltres?: number;
    qtres?: number;
    pathomit?: number;
    rightangleenhance?: boolean;
    colorsampling?: number;
    numberofcolors?: number;
    mincolorratio?: number;
    colorquantcycles?: number;
    layering?: number;
    strokewidth?: number;
    linefilter?: boolean;
    scale?: number;
    roundcoords?: number;
    viewbox?: boolean;
    desc?: boolean;
    lcpr?: number;
    qcpr?: number;
    blurradius?: number;
    blurdelta?: number;
    /** Custom fixed palette; overrides numberofcolors when provided. */
    pal?: TracePaletteColor[];
  }

  interface ImageTracerStatic {
    imagedataToTracedata(imageData: ImageData, options?: TraceOptions): Tracedata;
    imagedataToSVG(imageData: ImageData, options?: TraceOptions): string;
    getImgdata(canvas: HTMLCanvasElement): ImageData;
    loadImage(url: string, callback: (canvas: HTMLCanvasElement) => void): void;
  }

  const ImageTracer: ImageTracerStatic;
  export default ImageTracer;
}
