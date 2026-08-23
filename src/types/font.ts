export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  baseline: number;
  descender: number;
  capHeight: number;
  xHeight: number;
}

export interface FontInfo {
  familyName: string;
  styleName: string;
  fullName: string;
  postscriptName: string;
  designer: string;
  copyright: string;
  version: string;
  description: string;
  license: string;
  licenseURL: string;
  manufacturer?: string;
  manufacturerURL?: string;
  uniqueID?: string;
}

export const DEFAULT_METRICS: FontMetrics = {
  unitsPerEm: 1000,
  ascender: 800,
  baseline: 0,
  descender: -200,
  capHeight: 700,
  xHeight: 500,
};

function defaultPostScriptName(familyName: string): string {
  const family = familyName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\s()[\]{}<>/%]+/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "");
  return `${family || "UntitledFont"}-Regular`.slice(0, 63);
}

export function defaultFontInfo(familyName: string): FontInfo {
  return {
    familyName,
    styleName: "Regular",
    fullName: `${familyName} Regular`,
    postscriptName: defaultPostScriptName(familyName),
    designer: "",
    copyright: `Copyright © ${new Date().getFullYear()}`,
    version: "1.000",
    description: "",
    license: "",
    licenseURL: "",
    manufacturer: "",
    manufacturerURL: "",
    uniqueID: "",
  };
}
