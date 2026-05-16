import { ResourceVersion } from "@/lib/types";

/** 字体检测所需的最小输入，资源版本和放映聚合结果都可兼容 */
export interface FontDetectSource {
  font_names?: string[] | null;
  font_aliases?: Record<string, string[]> | null;
  missing_fonts?: string[] | null;
}

/** 字重推断 */
export interface WeightInfo {
  value: string;
  label: string;
}

export function inferFontWeight(fontName: string): WeightInfo {
  const lower = String(fontName || "").toLowerCase();
  const number = lower.match(/\b(105|95|85|75|65|55|45|35|25)\b/)?.[1];
  const byNumber: Record<string, [string, string]> = {
    "105": ["900", "105 Heavy"],
    "95": ["800", "95 ExtraBold"],
    "85": ["700", "85 Bold"],
    "75": ["600", "75 SemiBold"],
    "65": ["500", "65 Medium"],
    "55": ["400", "55 Regular"],
    "45": ["300", "45 Light"],
    "35": ["200", "35 Thin"],
    "25": ["100", "25 UltraLight"],
  };
  if (number && byNumber[number]) return { value: byNumber[number][0], label: byNumber[number][1] };
  if (lower.includes("heavy") || lower.includes("black")) return { value: "900", label: "Heavy / 900" };
  if (lower.includes("extrabold")) return { value: "800", label: "ExtraBold / 800" };
  if (lower.includes("bold")) return { value: "700", label: "Bold / 700" };
  if (lower.includes("semibold") || lower.includes("demibold"))
    return { value: "600", label: "SemiBold / 600" };
  if (lower.includes("medium")) return { value: "500", label: "Medium / 500" };
  if (lower.includes("regular")) return { value: "400", label: "Regular / 400" };
  if (lower.includes("light")) return { value: "300", label: "Light / 300" };
  if (lower.includes("thin")) return { value: "200", label: "Thin / 200" };
  return { value: "400", label: "Regular / 400" };
}

interface CanvasHolder {
  canvas?: HTMLCanvasElement;
}
const holder: CanvasHolder = {};

/** 基于 canvas measureText 粗略检测本机字体是否可用。true=有 false=无 null=不能判断 */
export function hasLocalFont(fontName: string, weight: string = "400"): boolean | null {
  const canvas = holder.canvas || (holder.canvas = document.createElement("canvas"));
  const context = canvas.getContext("2d");
  if (!context) return null;
  const samples = ["BESbswy 0123456789", "字体检测阿里巴巴普惠体", "mmmmmmmmmmiiiiiiiiii"];
  const family = `"${String(fontName).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const fallbacks = ["monospace", "serif", "sans-serif"];
  try {
    return fallbacks.some((fallback) =>
      samples.some((text) => {
        context.font = `normal ${weight} 72px ${fallback}`;
        const baseline = context.measureText(text).width;
        context.font = `normal ${weight} 72px ${family}, ${fallback}`;
        const measured = context.measureText(text).width;
        return Math.abs(measured - baseline) > 0.5;
      }),
    );
  } catch {
    return null;
  }
}

export interface FontCandidate {
  family: string;
  weight: WeightInfo;
}

export function fontCandidates(
  fontName: string,
  aliases: string[] = [],
  weight: WeightInfo,
): FontCandidate[] {
  const all = Array.from(
    new Set(
      [fontName, ...(aliases || [])].map((f) => String(f || "").trim()).filter(Boolean),
    ),
  );
  const styleHints = [/heavy/i, /regular/i, /bold/i, /medium/i, /light/i, /thin/i, /\b(105|95|85|75|65|55|45|35|25)\b/];
  return all
    .map((family) => ({
      family,
      exact: family === fontName || styleHints.some((p) => p.test(family)),
    }))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.family.localeCompare(b.family, "zh-Hans-CN"))
    .map((c) => ({ family: c.family, weight }));
}

export function hasAnyLocalFont(candidates: FontCandidate[]): { available: boolean | null; matched: string } {
  for (const candidate of candidates) {
    const available = hasLocalFont(candidate.family, candidate.weight.value);
    if (available === true) return { available: true, matched: candidate.family };
    if (available === null) return { available: null, matched: "" };
  }
  return { available: false, matched: "" };
}

export interface LocalFontRow {
  font: string;
  available: boolean | null;
  matched: string;
  weightLabel: string;
}

export interface LocalFontInfo {
  recommend: "ppt" | "zip";
  rows: LocalFontRow[];
  summary: string;
}

/** 基于版本的字体名和别名检测本机是否齐备，给出下载推荐 */
export function detectLocalFonts(
  source: FontDetectSource | ResourceVersion | null | undefined,
): LocalFontInfo {
  const fontNames = Array.from(new Set((source?.font_names || []).filter(Boolean)));
  if (!fontNames.length) {
    return { recommend: "ppt", rows: [], summary: "未检测到显式字体，推荐仅下载 PPT" };
  }
  const aliasMap = source?.font_aliases || {};
  const rows: LocalFontRow[] = fontNames.map((font) => {
    const weight = inferFontWeight(font);
    const result = hasAnyLocalFont(fontCandidates(font, aliasMap[font], weight));
    return { font, available: result.available, matched: result.matched, weightLabel: weight.label };
  });
  const unknownCount = rows.filter((r) => r.available === null).length;
  const missingCount = rows.filter((r) => r.available === false).length;
  if (!missingCount && !unknownCount) {
    return { recommend: "ppt", rows, summary: "本机字体齐全，推荐仅下载 PPT" };
  }
  if (unknownCount) {
    return { recommend: "zip", rows, summary: "本机字体无法完全确认，推荐下载 PPT + 字体包" };
  }
  return { recommend: "zip", rows, summary: `本机缺少 ${missingCount} 个字体，推荐下载 PPT + 字体包` };
}

/** 从 Content-Disposition 解出 filename */
export function filenameFromDisposition(disposition: string): string | null {
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1]);
  const plain = disposition.match(/filename="?([^"]+)"?/i);
  return plain ? plain[1] : null;
}

/** 资源下载 URL */
export function resourceDownloadUrl(
  resourceId: number,
  versionId: number | null | undefined,
  withFonts: boolean,
): string {
  const params = new URLSearchParams();
  if (withFonts) params.set("with_fonts", "true");
  if (versionId != null) params.set("version_id", String(versionId));
  const query = params.toString();
  return `/api/resources/${resourceId}/download${query ? `?${query}` : ""}`;
}

/** 放映 PDF 下载 URL */
export function showPdfDownloadUrl(showId: number): string {
  return `/api/shows/${showId}/download/pdf`;
}

/** 放映纯图 PPT 下载 URL（每张高清预览图一页） */
export function showImagesPptxDownloadUrl(showId: number): string {
  return `/api/shows/${showId}/download/pptx-images`;
}

/** 放映合并 PPTX 下载 URL，可选带上字体包 */
export function showPptxDownloadUrl(showId: number, withFonts: boolean): string {
  return `/api/shows/${showId}/download/pptx${withFonts ? "?with_fonts=true" : ""}`;
}

/** 放映逐个 PPT 压缩包下载 URL，可选带上字体包 */
export function showZipDownloadUrl(showId: number, withFonts: boolean): string {
  return `/api/shows/${showId}/download/zip${withFonts ? "?with_fonts=true" : ""}`;
}

/** 拉取放映的聚合字体信息 */
export async function fetchShowFonts(showId: number): Promise<FontDetectSource> {
  const resp = await fetch(`/api/shows/${showId}/fonts`, { credentials: "include" });
  if (!resp.ok) throw new Error("获取字体信息失败");
  return (await resp.json()) as FontDetectSource;
}

/** 通过 fetch 带进度拉取并触发浏览器下载 */
export async function downloadWithProgress(
  url: string,
  fallbackName: string,
  onProgress?: (percent: number | null, bytes: number) => void,
): Promise<void> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    let detail = "下载失败";
    try {
      const data = await response.json();
      if (data?.detail) detail = String(data.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    triggerBrowserDownload(blob, response.headers, fallbackName);
    return;
  }
  let received = 0;
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      onProgress?.(total ? (received / total) * 100 : null, received);
    }
  }
  triggerBrowserDownload(new Blob(chunks as BlobPart[]), response.headers, fallbackName);
}

function triggerBrowserDownload(blob: Blob, headers: Headers, fallbackName: string) {
  const disposition = headers.get("content-disposition") || "";
  const filename = filenameFromDisposition(disposition) || fallbackName;
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
