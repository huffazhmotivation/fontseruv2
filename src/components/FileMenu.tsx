import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FilePlus2, FileText, FolderOpen, Lock, Save, SaveAll, ScrollText, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import { useExportUsage } from "@/hooks/useExportUsage";
import type { FontInfo } from "@/types/font";
import { FONT_STYLES, fontStyleLabel, hasOutline, type FontStyle, type Glyph, type GlyphFamily } from "@/types/glyph";
import {
  createFontSeruProject,
  downloadProject,
  downloadBlob,
  parseFontSeruProject,
  safeFontFileBaseName,
  safeProjectBaseName,
} from "@/utils/projectIO";
import { generateFontFiles, type ExportFontFormat } from "@/utils/fontIO";
import { effectiveKerningPairs } from "@/types/kerning";
import { createZipBlob } from "@/utils/zip";
import { Toast, type ToastKind, type ToastMessage } from "@/components/Toast";

// --- Export Information System -------------------------------------------
// Purely additive: this data drives the OpenType name-table fields already
// accepted by `FontInfo` (unchanged) and two plain-text manifests bundled
// into the export ZIP. The TTF/OTF generator itself (`generateFontFiles`,
// `exportOTF`, `trueTypeWriter`) is never touched.

const LICENSE_TYPE_OPTIONS = ["Personal", "Commercial"] as const;
type LicenseType = (typeof LICENSE_TYPE_OPTIONS)[number] | "";

type ExportTab = "fontinfo" | "license";

interface FontInfoFormState {
  fontName: string;
  familyName: string;
  style: string;
  designerName: string;
  foundry: string;
  copyright: string;
  version: string;
  website: string;
}

interface LicenseInfoFormState {
  licenseType: LicenseType;
  licenseOwner: string;
  permission: string;
  restriction: string;
  note: string;
}

function emptyFontInfoForm(): FontInfoFormState {
  return {
    fontName: "",
    familyName: "",
    style: "Regular",
    designerName: "",
    foundry: "",
    copyright: "",
    version: "1.000",
    website: "",
  };
}

function emptyLicenseInfoForm(): LicenseInfoFormState {
  return {
    licenseType: "",
    licenseOwner: "",
    permission: "",
    restriction: "",
    note: "",
  };
}


interface WritableFontFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}

interface FontFileHandle {
  createWritable(): Promise<WritableFontFile>;
}

interface SaveFontFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
  excludeAcceptAllOption?: boolean;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: SaveFontFilePickerOptions) => Promise<FontFileHandle>;
};

type SaveFontResult = "saved" | "downloaded" | "cancelled";
type SaveExportExtension = "ttf" | "otf" | "zip";

function isAbortError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError";
}

async function saveFontBlob(blob: Blob, filename: string, extension: SaveExportExtension): Promise<SaveFontResult> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker !== "function" || !globalThis.isSecureContext) {
    downloadBlob(blob, filename);
    return "downloaded";
  }

  try {
    const mimeType = extension === "ttf"
      ? "font/ttf"
      : extension === "otf"
        ? "font/otf"
        : "application/zip";
    const description = extension === "ttf"
      ? "TrueType Font"
      : extension === "otf"
        ? "OpenType Font"
        : "Font ZIP Archive";
    const handle = await picker({
      suggestedName: filename,
      types: [{
        description,
        accept: { [mimeType]: [`.${extension}`] },
      }],
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      if (typeof writable.abort === "function") {
        try { await writable.abort(); } catch { /* preserve original write error */ }
      }
      throw error;
    }
    return "saved";
  } catch (error) {
    if (isAbortError(error)) return "cancelled";
    throw error;
  }
}

function snapshotFromStore() {
  const s = useAppStore.getState();
  return createFontSeruProject({
    fontName: s.fontName,
    fontInfo: s.fontInfo,
    metrics: s.metrics,
    glyphs: s.glyphsByStyle.regular,
    glyphsByStyle: s.glyphsByStyle,
    fontStyle: s.fontStyle,
    kerningPairs: s.kerningPairs,
    kerningManual: s.kerningManual,
    kerningOverridesByStyle: s.kerningOverridesByStyle,
    kerningOverrideManualByStyle: s.kerningOverrideManualByStyle,
    activeChar: s.activeChar,
    gridSize: s.gridSize,
    showGrid: s.showGrid,
    showGuides: s.showGuides,
    ghost: s.ghost,
    brush: s.brush,
  });
}

function hydrateProject(project: ReturnType<typeof parseFontSeruProject>, filename: string) {
  const s = useAppStore.getState();
  s.hydrate({
    glyphs: project.font.glyphs,
    glyphsByStyle: project.font.glyphsByStyle,
    fontStyle: project.editor.fontStyle,
    fontName: project.font.name,
    fontInfo: project.font.info,
    projectFileName: filename,
    metrics: project.font.metrics,
    kerningPairs: project.font.kerningPairs,
    kerningManual: project.font.kerningManual,
    kerningOverridesByStyle: project.font.kerningOverridesByStyle,
    kerningOverrideManualByStyle: project.font.kerningOverrideManualByStyle,
    activeChar: project.editor.activeChar,
    gridSize: project.editor.gridSize,
    showGrid: project.editor.showGrid,
    showGuides: project.editor.showGuides,
    ghost: project.editor.ghost,
    brush: project.editor.brush,
  });
}

function userFileError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("Choose a ") ||
    message.startsWith("Not a FontSeru") ||
    message.startsWith("Unsupported FontSeru") ||
    message.startsWith("Incomplete FontSeru") ||
    message.includes("no Unicode-mapped glyphs")
  ) return message;
  return "Unable to open this file. Please make sure it is a valid FontSeru project, TTF, or OTF font.";
}

type FamilyStyleSelection = Record<FontStyle, boolean>;

function hasExportableVectorGlyph(glyph: Glyph): boolean {
  if (!hasOutline(glyph)) return false;
  return glyph.outline.objects.some((object) =>
    object.contours.some((contour) => contour.nodes.length >= 2),
  );
}

function detectExportableStyles(family: GlyphFamily): FamilyStyleSelection {
  const result: FamilyStyleSelection = { regular: false, bold: false, italic: false };
  for (const { id } of FONT_STYLES) {
    result[id] = Object.values(family[id] ?? {}).some(hasExportableVectorGlyph);
  }
  return result;
}

function selectedExportStyles(
  selected: FamilyStyleSelection,
  available: FamilyStyleSelection,
): FontStyle[] {
  return FONT_STYLES
    .map(({ id }) => id)
    .filter((style) => selected[style] && available[style]);
}

export function FileMenu({ onExportButtonReady }: { onExportButtonReady?: (open: () => void) => void }) {
  const [open, setOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const projectFileName = useAppStore((s) => s.projectFileName);
  const setProjectFileName = useAppStore((s) => s.setProjectFileName);
  const newProject = useAppStore((s) => s.newProject);
  const glyphsByStyle = useAppStore((s) => s.glyphsByStyle);
  const styleAvailability = detectExportableStyles(glyphsByStyle);
  const openProModal = useAppStore((s) => s.openProModal);
  const { isPro } = useAuth();
  const { usage: exportUsage, refresh: refreshExportUsage, consumeExport } = useExportUsage();

  const [format, setFormat] = useState<ExportFontFormat>("ttf");
  const [exportTab, setExportTab] = useState<ExportTab>("fontinfo");
  const [fontInfoForm, setFontInfoForm] = useState<FontInfoFormState>(emptyFontInfoForm);
  const [licenseInfoForm, setLicenseInfoForm] = useState<LicenseInfoFormState>(emptyLicenseInfoForm);
  const [selectedStyles, setSelectedStyles] = useState<FamilyStyleSelection>({
    regular: true,
    bold: false,
    italic: false,
  });

  const setFontInfoField = useCallback(<K extends keyof FontInfoFormState>(field: K, value: FontInfoFormState[K]) => {
    setFontInfoForm((current) => ({ ...current, [field]: value }));
  }, []);

  const setLicenseInfoField = useCallback(<K extends keyof LicenseInfoFormState>(field: K, value: LicenseInfoFormState[K]) => {
    setLicenseInfoForm((current) => ({ ...current, [field]: value }));
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);
  const showToast = useCallback((message: string, kind: ToastKind = "success") => {
    setToast({ id: ++toastId.current, kind, message });
  }, []);


  const beginExport = useCallback(() => {
    const s = useAppStore.getState();
    const initialFontName = s.fontInfo.familyName?.trim() || s.fontName || "";
    const existingLicense = s.fontInfo.license?.trim() || "";
    const knownLicenseType = LICENSE_TYPE_OPTIONS.find((option) => existingLicense.toLowerCase().startsWith(option.toLowerCase()));

    setFontInfoForm({
      fontName: initialFontName,
      familyName: s.fontInfo.familyName?.trim() || initialFontName,
      style: fontStyleLabel(s.fontStyle),
      designerName: s.fontInfo.designer?.trim() || "",
      foundry: s.fontInfo.manufacturer?.trim() || "",
      copyright: s.fontInfo.copyright?.trim() || (initialFontName ? `Copyright © ${new Date().getFullYear()} ${initialFontName}` : ""),
      version: s.fontInfo.version?.trim() || "1.000",
      website: s.fontInfo.manufacturerURL?.trim() || "",
    });
    setLicenseInfoForm({
      licenseType: knownLicenseType ?? "",
      licenseOwner: s.fontInfo.designer?.trim() || "",
      permission: "",
      restriction: "",
      note: "",
    });
    setFormat("ttf");
    setSelectedStyles(detectExportableStyles(s.glyphsByStyle));
    setExportTab("fontinfo");
    setExportOpen(true);
    setOpen(false);
    void refreshExportUsage();
  }, [refreshExportUsage]);

  useEffect(() => {
    onExportButtonReady?.(beginExport);
  }, [beginExport, onExportButtonReady]);

  const save = () => {
    try {
      // Always derive from the live font name so a rename is picked up
      // automatically, even if this project was already saved before.
      const name = `${safeProjectBaseName(useAppStore.getState().fontName || projectFileName)}.fs`;
      downloadProject(snapshotFromStore(), name);
      setProjectFileName(name);
      showToast("Project saved");
    } catch (error) {
      console.error("[FontSeru] Project save failed.", error);
      showToast("Unable to save the project.", "error");
    } finally {
      setOpen(false);
    }
  };

  const saveAs = () => {
    const current = safeProjectBaseName(useAppStore.getState().fontName || projectFileName);
    const chosen = window.prompt("Save FontSeru project as", current);
    if (!chosen) return;
    try {
      const filename = `${safeProjectBaseName(chosen)}.fs`;
      setProjectFileName(filename);
      downloadProject(snapshotFromStore(), filename);
      showToast("Project saved");
    } catch (error) {
      console.error("[FontSeru] Project save-as failed.", error);
      showToast("Unable to save the project.", "error");
    } finally {
      setOpen(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext === "fs") {
        const project = parseFontSeruProject(await file.text());
        hydrateProject(project, file.name);
        showToast("Project opened");
      } else if (ext === "ttf" || ext === "otf") {
        const { importOpenType } = await import("@/utils/fontIO");
        const imported = importOpenType(await file.arrayBuffer());
        useAppStore.getState().hydrate({
          glyphs: imported.glyphs,
          fontName: imported.fontName,
          fontInfo: imported.fontInfo,
          projectFileName: `${safeProjectBaseName(imported.fontName)}.fs`,
          metrics: imported.metrics,
          kerningPairs: imported.kerningPairs,
          kerningManual: {},
          activeChar: Object.keys(imported.glyphs)[0],
        });
        showToast("Font imported successfully");
      } else {
        throw new Error("Choose a .fs, .ttf, or .otf file.");
      }
    } catch (error) {
      console.error("[FontSeru] File import/open failed.", error);
      showToast(userFileError(error), "error");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
      setOpen(false);
    }
  };

  const runExport = async () => {
    if (busy) return;

    // --- Export Information System validation ---------------------------
    // Font name and Designer are required in FONT INFO; a License Type must
    // be picked in LICENSE INFO. None of this touches the TTF/OTF engine.
    const fontName = fontInfoForm.fontName.trim();
    if (!fontName) {
      showToast("Font Name wajib diisi.", "error");
      setExportTab("fontinfo");
      return;
    }

    const designerName = fontInfoForm.designerName.trim();
    if (!designerName) {
      showToast("Designer Name wajib diisi.", "error");
      setExportTab("fontinfo");
      return;
    }

    if (!licenseInfoForm.licenseType) {
      showToast("Pilih License Type sebelum export.", "error");
      setExportTab("license");
      return;
    }

    const familyName = fontInfoForm.familyName.trim() || fontName;
    const foundry = fontInfoForm.foundry.trim();
    const website = fontInfoForm.website.trim();
    const version = fontInfoForm.version.trim() || "1.000";
    const copyright = fontInfoForm.copyright.trim() || `Copyright © ${new Date().getFullYear()} ${fontName}`;
    const resolvedLicense = licenseInfoForm.licenseOwner.trim()
      ? `${licenseInfoForm.licenseType} - ${licenseInfoForm.licenseOwner.trim()}`
      : licenseInfoForm.licenseType;

    const availableAtExport = detectExportableStyles(useAppStore.getState().glyphsByStyle);
    // Real enforcement point (not just checkbox styling): FREE accounts can
    // only ever export Regular, regardless of what `selectedStyles` holds.
    const allowedAtExport: FamilyStyleSelection = isPro
      ? availableAtExport
      : { regular: availableAtExport.regular, bold: false, italic: false };
    const styles = selectedExportStyles(selectedStyles, allowedAtExport);
    if (!styles.length) {
      showToast("Select at least one style with vector glyphs.", "error");
      return;
    }

    // Real enforcement point for the FREE export limit (1x/calendar month).
    // This runs right before the font is actually generated/downloaded —
    // not just when the button is styled — and the allow/deny decision is
    // made server-side by the `increment_export_usage` RPC, so it can't be
    // bypassed by editing client code. PRO accounts always come back
    // allowed=true here and are never counted.
    setBusy(true);
    const quota = await consumeExport();
    if (!quota.allowed) {
      setBusy(false);
      setExportOpen(false);
      openProModal("export");
      return;
    }

    try {
      const s = useAppStore.getState();
      const baseName = safeFontFileBaseName(fontName);
      const multiStyle = styles.length > 1;
      const files: Array<{
        extension: "ttf" | "otf";
        name: string;
        blob: Blob;
      }> = [];

      // A user-entered Style name (FONT INFO tab) is honored for the common
      // single-style export. For multi-style Family exports each binary
      // still needs its own correct Regular/Bold/Italic subfamily name for
      // OS font matching, so the automatic label is kept there.
      const styleOverride = fontInfoForm.style.trim();

      // Family export is orchestration only: each selected style still passes
      // through the existing font generator and its validation pipeline.
      for (const style of styles) {
        const styleName = styles.length === 1 && styleOverride ? styleOverride : fontStyleLabel(style);
        const exportInfo: FontInfo = {
          ...s.fontInfo,
          familyName,
          styleName,
          fullName: `${fontName} ${styleName}`,
          // Let normalization create a unique Family-Style PostScript name and
          // matching unique ID for every binary.
          postscriptName: "",
          uniqueID: "",
          designer: designerName,
          manufacturer: foundry,
          manufacturerURL: website,
          copyright,
          version,
          license: resolvedLicense,
          licenseURL: website,
        };

        const effectiveKerning = effectiveKerningPairs(
          s.kerningPairs,
          s.kerningOverridesByStyle,
          style,
        );
        let generated: Awaited<ReturnType<typeof generateFontFiles>>;
        try {
          generated = await generateFontFiles(
            s.glyphsByStyle[style],
            s.metrics,
            exportInfo,
            effectiveKerning,
            format,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to export ${styleName}. ${detail}`);
        }
        if (!generated.length) throw new Error(`No font file was generated for ${styleName}.`);

        const fileBase = multiStyle || style !== "regular"
          ? `${baseName}-${styleName}`
          : baseName;

        for (const file of generated) {
          files.push({
            extension: file.extension,
            name: `${fileBase}.${file.extension}`,
            blob: new Blob([file.buffer], { type: file.mimeType }),
          });
        }
      }

      // --- Export Information System: manifests -----------------------
      // Bundled into the ZIP alongside the untouched TTF/OTF output.
      const creationDate = new Date().toISOString().slice(0, 10);
      const textEncoder = (text: string) => new Blob([text], { type: "text/plain" });

      const fontInfoText = [
        `Name: ${fontName}`,
        `Designer: ${designerName}`,
        `Version: ${version}`,
        `Copyright: ${copyright}`,
        `Creation Date: ${creationDate}`,
      ].join("\n") + "\n";

      const licenseText = [
        `Font Name: ${fontName}`,
        `Creator: ${designerName}`,
        `License Type: ${licenseInfoForm.licenseType}`,
        licenseInfoForm.licenseOwner.trim() ? `License Owner: ${licenseInfoForm.licenseOwner.trim()}` : null,
        `Permission: ${licenseInfoForm.permission.trim() || "-"}`,
        `Restriction: ${licenseInfoForm.restriction.trim() || "-"}`,
        licenseInfoForm.note.trim() ? `Note: ${licenseInfoForm.note.trim()}` : null,
      ].filter((line): line is string => line !== null).join("\n") + "\n";

      // Export always ships as a ZIP now: font binaries + FontInfo.txt +
      // License.txt, per the Export Information System spec.
      const zipEntries = [
        ...files.map((file) => ({ name: file.name, blob: file.blob })),
        { name: "FontInfo.txt", blob: textEncoder(fontInfoText) },
        { name: "License.txt", blob: textEncoder(licenseText) },
      ];
      const zipBlob = await createZipBlob(zipEntries);
      const zipName = styles.length > 1 ? `${baseName}-Family.zip` : `${baseName}.zip`;
      const result = await saveFontBlob(zipBlob, zipName, "zip");
      if (result === "cancelled") return;

      setExportOpen(false);
      showToast(styles.length > 1 ? "Font family ZIP saved successfully" : "Font ZIP saved successfully");
    } catch (error) {
      console.error("[FontSeru] Export failed:", error);
      const detail = error instanceof Error ? error.message.trim() : "";
      const message = detail && detail.length <= 220
        ? detail
        : "Unable to generate the font. Please check the font name and glyph data.";
      showToast(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const availableStyleCount = FONT_STYLES.filter(({ id }) => styleAvailability[id]).length;
  const selectedStyleList = selectedExportStyles(selectedStyles, styleAvailability);
  const selectedStyleCount = selectedStyleList.length;
  const primaryExportLabel = selectedStyleCount > 1
    ? (selectedStyleCount === availableStyleCount ? "Export All Family ZIP" : "Export Family ZIP")
    : selectedStyleCount === 1
      ? `Export ${fontStyleLabel(selectedStyleList[0])} ZIP`
      : "Select a style";


  return (
    <>
      <div className="fm-filemenu-wrap">
        <button
          className="fm-topbtn"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          data-testid="file-menu-btn"
        >
          File <ChevronDown size={13} />
        </button>

        {open && (
          <div className="fm-filemenu" role="menu">
            <button onClick={() => { newProject(); setOpen(false); showToast("New project created"); }}>
              <FilePlus2 size={14} /> New
            </button>
            <button onClick={() => inputRef.current?.click()} disabled={busy}>
              <FolderOpen size={14} /> Open / Import…
            </button>
            <div className="fm-filemenu-sep" />
            <button onClick={save}><Save size={14} /> Save <kbd>⌘S</kbd></button>
            <button onClick={saveAs}><SaveAll size={14} /> Save As…</button>
            <div className="fm-filemenu-sep" />
            <button onClick={beginExport}><Download size={14} /> Export Font…</button>
          </div>
        )}

        <input
          ref={inputRef}
          hidden
          type="file"
          // iPadOS/Safari's Files picker matches `accept` against known UTTypes,
          // not raw extensions — since ".fs" isn't a registered system type, an
          // extension-only/unrecognized-MIME accept list (the previous value)
          // makes .fs files render greyed-out and unselectable there, even
          // though the exact same list works fine on desktop browsers. Widening
          // this with generic MIME types that DO map to known UTTypes (.fs is
          // plain JSON text, so "application/json"/"text/plain"/
          // "application/octet-stream" all resolve to something iOS
          // recognizes) keeps every file kind selectable everywhere. This is
          // purely a picker-compatibility hint — the actual accept/reject
          // decision still happens after selection, in importFile() below,
          // which checks the real file extension regardless of what MIME type
          // (if any) the OS reports.
          accept=".fs,.ttf,.otf,font/ttf,font/otf,application/json,text/plain,application/octet-stream"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </div>

      <Toast toast={toast} onClose={dismissToast} />

      {exportOpen && (
        <div
          className="fm-export-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !busy) setExportOpen(false);
          }}
        >
          <section className="fm-export-dialog" role="dialog" aria-modal="true" aria-labelledby="font-export-title">
            <header>
              <div>
                <span className="fm-panel-eyebrow">Download</span>
                <h2 id="font-export-title">Export Font</h2>
              </div>
              <button
                type="button"
                className="fm-iconbtn"
                onClick={() => setExportOpen(false)}
                disabled={busy}
                aria-label="Close export dialog"
              >
                <X size={17} />
              </button>
            </header>

            <div className="fm-export-tabs" role="tablist" aria-label="Export information">
              <button
                type="button"
                role="tab"
                aria-selected={exportTab === "fontinfo"}
                className={`fm-export-tab${exportTab === "fontinfo" ? " active" : ""}`}
                onClick={() => setExportTab("fontinfo")}
              >
                <FileText size={13} /> Font Info
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={exportTab === "license"}
                className={`fm-export-tab${exportTab === "license" ? " active" : ""}`}
                onClick={() => setExportTab("license")}
              >
                <ScrollText size={13} /> License Info
              </button>
            </div>

            {exportTab === "fontinfo" && (
              <div className="fm-export-form" role="tabpanel" aria-label="Font info">
                <label className="fm-export-field">
                  <span>Font Name</span>
                  <input
                    value={fontInfoForm.fontName}
                    onChange={(event) => setFontInfoField("fontName", event.target.value)}
                    autoFocus
                    spellCheck={false}
                    placeholder="My Font"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Family Name</span>
                  <input
                    value={fontInfoForm.familyName}
                    onChange={(event) => setFontInfoField("familyName", event.target.value)}
                    spellCheck={false}
                    placeholder="Defaults to Font Name"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Style</span>
                  <input
                    value={fontInfoForm.style}
                    onChange={(event) => setFontInfoField("style", event.target.value)}
                    spellCheck={false}
                    placeholder="Regular"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Designer Name</span>
                  <input
                    value={fontInfoForm.designerName}
                    onChange={(event) => setFontInfoField("designerName", event.target.value)}
                    placeholder="Your name"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Foundry</span>
                  <input
                    value={fontInfoForm.foundry}
                    onChange={(event) => setFontInfoField("foundry", event.target.value)}
                    placeholder="Foundry / studio name"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Copyright</span>
                  <input
                    value={fontInfoForm.copyright}
                    onChange={(event) => setFontInfoField("copyright", event.target.value)}
                    placeholder={`Copyright © ${new Date().getFullYear()}`}
                  />
                </label>

                <label className="fm-export-field">
                  <span>Version</span>
                  <input
                    value={fontInfoForm.version}
                    onChange={(event) => setFontInfoField("version", event.target.value)}
                    placeholder="1.000"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Website</span>
                  <input
                    value={fontInfoForm.website}
                    onChange={(event) => setFontInfoField("website", event.target.value)}
                    spellCheck={false}
                    placeholder="https://example.com"
                  />
                </label>
              </div>
            )}

            {exportTab === "license" && (
              <div className="fm-export-form" role="tabpanel" aria-label="License info">
                <label className="fm-export-field">
                  <span>License Type</span>
                  <select
                    value={licenseInfoForm.licenseType}
                    onChange={(event) => setLicenseInfoField("licenseType", event.target.value as LicenseType)}
                  >
                    <option value="">Select license type…</option>
                    {LICENSE_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>

                <label className="fm-export-field">
                  <span>License Owner</span>
                  <input
                    value={licenseInfoForm.licenseOwner}
                    onChange={(event) => setLicenseInfoField("licenseOwner", event.target.value)}
                    placeholder="Name of the license owner"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Permission</span>
                  <input
                    value={licenseInfoForm.permission}
                    onChange={(event) => setLicenseInfoField("permission", event.target.value)}
                    placeholder="e.g. Free for personal projects"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Restriction</span>
                  <input
                    value={licenseInfoForm.restriction}
                    onChange={(event) => setLicenseInfoField("restriction", event.target.value)}
                    placeholder="e.g. No resale or redistribution"
                  />
                </label>

                <label className="fm-export-field">
                  <span>Note</span>
                  <input
                    value={licenseInfoForm.note}
                    onChange={(event) => setLicenseInfoField("note", event.target.value)}
                    placeholder="Optional note"
                  />
                </label>
              </div>
            )}

            <div className="fm-export-form fm-export-options">
              <div className="fm-export-field">
                <span>Styles</span>
                <div className="fm-export-style-list" role="group" aria-label="Font family styles">
                  {FONT_STYLES.map(({ id, label }) => {
                    const available = styleAvailability[id];
                    // Bold/Italic ("Export Family") are PRO-only; Regular
                    // stays free for everyone. Locked options stay visible
                    // (dimmed + lock icon) per spec rather than being
                    // hidden, and tapping them opens the existing
                    // ProUpsellModal instead of toggling the checkbox. This
                    // is UI-level; runExport() below also strips any
                    // non-regular style for FREE as the real enforcement
                    // point, so this can't be bypassed by forcing the
                    // checkbox state some other way.
                    const locked = id !== "regular" && !isPro;
                    const checked = available && selectedStyles[id] && !locked;
                    return (
                      <label
                        key={id}
                        className={`fm-export-style-option${available ? "" : " disabled"}${locked ? " fm-export-style-locked" : ""}`}
                        title={locked ? `${label} (PRO)` : available ? `${label} vector glyphs detected` : `${label} has no vector glyphs`}
                        onClick={(event) => {
                          if (locked) {
                            event.preventDefault();
                            openProModal("family");
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!available || busy || locked}
                          onChange={(event) => {
                            if (locked) return;
                            const value = event.target.checked;
                            setSelectedStyles((current) => ({ ...current, [id]: value }));
                          }}
                        />
                        <span className="fm-export-checkmark" aria-hidden="true" />
                        <span className="fm-export-style-name">{label}</span>
                        {locked && <Lock size={11} className="fm-lock-badge-inline" />}
                        {!locked && !available && <span className="fm-export-style-status">No vectors</span>}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="fm-export-field">
                <span>Format</span>
                <div className="fm-format-segment" role="group" aria-label="Font format">
                  {(["ttf", "otf", "both"] as ExportFontFormat[]).map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={format === value ? "active" : ""}
                      onClick={() => setFormat(value)}
                      aria-pressed={format === value}
                    >
                      {value === "both" ? "TTF + OTF" : value.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

            </div>

            {!isPro && exportUsage && !exportUsage.unlimited && (
              <p className="fm-auth-note fm-export-quota-note" data-testid="export-quota-note">
                {exportUsage.limit !== null && exportUsage.used !== null && exportUsage.used >= exportUsage.limit
                  ? `Batas export FREE bulan ini sudah tercapai (${exportUsage.used}/${exportUsage.limit}). Upgrade ke PRO untuk export tanpa batas.`
                  : `Export FREE: ${exportUsage.used ?? 0}/${exportUsage.limit ?? 1} bulan ini.`}
              </p>
            )}

            <footer className="fm-export-actions">
              <button type="button" className="fm-secondary-btn" onClick={() => setExportOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="fm-primary-btn"
                onClick={() => void runExport()}
                disabled={busy || selectedStyleCount === 0}
              >
                <Download size={15} /> {busy ? "Preparing…" : primaryExportLabel}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
