export type ToolId =
  | "home"
  | "select"
  | "pen"
  | "brush"
  | "eraser"
  | "node"
  | "shape"
  | "import"
  | "hand"
  | "zoom";

export interface ToolConfig {
  id: ToolId;
  label: string;
  key: string;
  /** The phase in which this tool becomes interactive. */
  phase: number;
}
