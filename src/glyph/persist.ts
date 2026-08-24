import type { FontStyle, GlyphFamily, GlyphMap } from "@/types/glyph";
import type { KerningPairs, KerningManualFlags, KerningOverridesByStyle, KerningOverrideManualByStyle } from "@/types/kerning";
import type { FontInfo, FontMetrics } from "@/types/font";

/**
 * Minimal IndexedDB persistence (no external deps). The whole working glyph
 * map + font name are stored under one key and restored on load, so edited
 * glyphs survive a full browser reload. Kerning data was added additively
 * in Phase 6 — `loadProject` on an older saved snapshot (no kerning fields)
 * just gets `undefined` for them, which the store's `hydrate` already
 * treats as "keep the current default".
 */
const DB_NAME = "fontseru";
const STORE = "project";
const KEY = "current";
const VERSION = 1;

interface ProjectSnapshot {
  /** Regular glyphs kept for backward compatibility with older snapshots. */
  glyphs: GlyphMap;
  glyphsByStyle?: GlyphFamily;
  fontStyle?: FontStyle;
  fontName: string;
  fontInfo?: FontInfo;
  metrics?: FontMetrics;
  kerningPairs?: KerningPairs;
  kerningManual?: KerningManualFlags;
  kerningOverridesByStyle?: KerningOverridesByStyle;
  kerningOverrideManualByStyle?: KerningOverrideManualByStyle;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadProject(): Promise<ProjectSnapshot | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as ProjectSnapshot) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveProject(snapshot: ProjectSnapshot): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(snapshot, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* storage unavailable — editing still works in-session */
  }
}
