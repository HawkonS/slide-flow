import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ExternalLink, FileText, Loader2, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FilePickerCard } from "@/components/resource/FilePickerCard";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import { api, apiNdjson, apiUploadWithProgress } from "@/lib/api";
import { parsePreviewRenderEvent } from "@/lib/resourceImportStream";
import { cn } from "@/lib/utils";
import type { FontItem, Resource } from "@/lib/types";

export interface ResourceNewVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource | null;
}

type Step = "upload" | "fonts" | "preview";
type Operation = "upload" | "replace" | "render" | "commit" | null;
type PreviewStatus = "pending" | "rendering" | "ready" | "error";

interface PrepareResult {
  session_id: string;
  slide_count: number;
  fonts: string[];
  missing_fonts: string[];
  preview_status: PreviewStatus;
}

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "upload", label: "上传资料" },
  { id: "fonts", label: "字体检查" },
  { id: "preview", label: "图片确认" },
];
const PPT_EXTENSIONS = new Set([".pptx", ".potx", ".ppsx"]);
const MAX_PPT_BYTES = 10 * 1024 * 1024 * 1024;

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function ResourceNewVersionDialog({ open, onOpenChange, resource }: ResourceNewVersionDialogProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = React.useState<Step>("upload");
  const [operation, setOperation] = React.useState<Operation>(null);
  const operationRef = React.useRef<Operation>(null);
  const renderAbortRef = React.useRef<AbortController | null>(null);
  const [pptFile, setPptFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [changeNote, setChangeNote] = React.useState("");
  const [commonRemark, setCommonRemark] = React.useState("");
  const [inheritPersonal, setInheritPersonal] = React.useState(true);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [fonts, setFonts] = React.useState<string[]>([]);
  const [missingFonts, setMissingFonts] = React.useState<string[]>([]);
  const [replacements, setReplacements] = React.useState<Record<string, string>>({});
  const [standardFonts, setStandardFonts] = React.useState<FontItem[]>([]);
  const [standardFontsLoading, setStandardFontsLoading] = React.useState(false);
  const [standardFontsError, setStandardFontsError] = React.useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = React.useState<PreviewStatus>("pending");
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [renderMessage, setRenderMessage] = React.useState("");
  const [uploadProgress, setUploadProgress] = React.useState(0);

  const setOperationSafe = React.useCallback((value: Operation) => {
    operationRef.current = value;
    setOperation(value);
  }, []);

  const resetState = React.useCallback(() => {
    renderAbortRef.current?.abort();
    renderAbortRef.current = null;
    setStep("upload");
    setOperationSafe(null);
    setPptFile(null);
    setFileError(null);
    setChangeNote("");
    setCommonRemark(resource?.current?.common_remark_html ?? "");
    setInheritPersonal(true);
    setSessionId(null);
    setFonts([]);
    setMissingFonts([]);
    setReplacements({});
    setPreviewStatus("pending");
    setPreviewUrl(null);
    setPreviewLoaded(false);
    setPreviewError(null);
    setRenderMessage("");
    setUploadProgress(0);
  }, [resource?.current?.common_remark_html, setOperationSafe]);

  React.useEffect(() => {
    if (!open) return;
    resetState();
    let cancelled = false;
    setStandardFontsLoading(true);
    setStandardFontsError(null);
    api<{ fonts: FontItem[] }>("/api/fonts")
      .then((result) => { if (!cancelled) setStandardFonts(result.fonts || []); })
      .catch((error: Error) => { if (!cancelled) setStandardFontsError(error.message || "标准字体加载失败"); })
      .finally(() => { if (!cancelled) setStandardFontsLoading(false); });
    return () => { cancelled = true; };
  }, [open, resource?.id, resetState]);

  const cancelSession = React.useCallback(async (id: string | null) => {
    if (!id) return;
    try {
      await api("/api/resource-import/" + id, { method: "DELETE" });
    } catch {
      // 临时会话会由后台过期清理。
    }
  }, []);

  const requestClose = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    if (operationRef.current === "upload" || operationRef.current === "commit") {
      toast.info(operationRef.current === "upload" ? "PPT 正在上传，请稍候" : "正在保存新版本，请稍候");
      return;
    }
    renderAbortRef.current?.abort();
    const currentSession = sessionId;
    setSessionId(null);
    void cancelSession(currentSession);
    onOpenChange(false);
  };

  const handlePptChange = (file: File | null) => {
    const suffix = file ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
    const error = file && !PPT_EXTENSIONS.has(suffix)
      ? "仅支持 PPTX、POTX、PPSX；旧版 PPT 请先另存为 PPTX"
      : file && !file.size
        ? "PPT 文件为空，请重新选择"
        : file && file.size > MAX_PPT_BYTES
          ? "PPT 文件不能超过 10 GB"
          : null;
    setPptFile(error ? null : file);
    setFileError(error);
  };

  const generatePreview = React.useCallback(async (id: string) => {
    renderAbortRef.current?.abort();
    const controller = new AbortController();
    renderAbortRef.current = controller;
    setOperationSafe("render");
    setStep("preview");
    setPreviewStatus("rendering");
    setPreviewUrl(null);
    setPreviewLoaded(false);
    setPreviewError(null);
    setRenderMessage("正在提交后台图片渲染任务…");
    let completed = false;
    try {
      const result = await apiNdjson<unknown, { preview_status?: PreviewStatus; preview_count?: number }>(
        "/api/resource-import/" + id + "/previews",
        (raw) => {
          const event = parsePreviewRenderEvent(raw, id, 1, window.location.origin);
          if (event.type === "page") setPreviewUrl(event.preview_url);
          else if (event.type === "completed") completed = true;
          else if ((event.type === "started" || event.type === "progress" || event.type === "heartbeat") && event.message) setRenderMessage(event.message);
          else if (event.type === "error") throw new Error(event.message);
        },
        { method: "POST", signal: controller.signal },
      );
      if (!completed && !(result?.preview_status === "ready" && result.preview_count === 1)) throw new Error("图片渲染结果不完整，请重试");
      setPreviewStatus("ready");
      setRenderMessage("高清图片已生成，请核对内容、字体和版式");
      toast.success("预览图已生成");
    } catch (error) {
      if (!controller.signal.aborted) {
        setPreviewStatus("error");
        setPreviewError((error as Error).message || "图片渲染失败，请重试");
        setRenderMessage("后台图片渲染未完成");
      }
    } finally {
      if (renderAbortRef.current === controller) renderAbortRef.current = null;
      if (operationRef.current === "render") setOperationSafe(null);
    }
  }, [setOperationSafe]);

  const uploadAndCheck = async () => {
    if (!resource || operationRef.current) return;
    if (!pptFile) {
      setFileError("请选择单页 PPT 文件");
      return;
    }
    if (!changeNote.trim()) {
      toast.error("请填写版本说明");
      return;
    }
    setOperationSafe("upload");
    setUploadProgress(0);
    setFileError(null);
    let autoRenderSession: string | null = null;
    try {
      const form = new FormData();
      form.append("mode", "ppt");
      form.append("ppt_file", pptFile);
      const result = await apiUploadWithProgress<PrepareResult>("/api/resource-import/prepare", form, (percent) => setUploadProgress(percent));
      if (result.slide_count !== 1) {
        await cancelSession(result.session_id);
        throw new Error("该文件包含 " + result.slide_count + " 页，版本迭代只能上传 1 页 PPT");
      }
      setSessionId(result.session_id);
      setFonts(result.fonts || []);
      setMissingFonts(result.missing_fonts || []);
      setReplacements({});
      setPreviewStatus(result.preview_status || "pending");
      setStep("fonts");
      if (result.missing_fonts?.length) toast.info("检测到 " + result.missing_fonts.length + " 个非标准字体，请先替换");
      else autoRenderSession = result.session_id;
    } catch (error) {
      setFileError((error as Error).message || "PPT 上传或字体检查失败");
    } finally {
      if (operationRef.current === "upload") setOperationSafe(null);
    }
    if (autoRenderSession) void generatePreview(autoRenderSession);
  };

  const replaceFonts = async () => {
    if (!sessionId || operationRef.current) return;
    const selected: Record<string, string> = {};
    for (const font of missingFonts) {
      if (!replacements[font]) {
        toast.error("请为每个非标准字体选择替换字体");
        return;
      }
      selected[font] = replacements[font];
    }
    setOperationSafe("replace");
    let shouldRender = false;
    try {
      const result = await api<{ fonts: string[]; missing_fonts: string[]; preview_status?: PreviewStatus }>(
        "/api/resource-import/" + sessionId + "/replace-fonts",
        { method: "POST", json: selected },
      );
      setFonts(result.fonts || []);
      setMissingFonts(result.missing_fonts || []);
      setReplacements({});
      if (result.missing_fonts?.length) toast.error("替换后仍有非标准字体，请继续处理");
      else shouldRender = true;
    } catch (error) {
      toast.error((error as Error).message || "字体替换失败");
    } finally {
      if (operationRef.current === "replace") setOperationSafe(null);
    }
    if (shouldRender) void generatePreview(sessionId);
  };

  const restartUpload = async () => {
    if (operationRef.current === "upload" || operationRef.current === "commit") return;
    renderAbortRef.current?.abort();
    const oldSession = sessionId;
    setSessionId(null);
    await cancelSession(oldSession);
    setStep("upload");
    setPptFile(null);
    setFileError(null);
    setFonts([]);
    setMissingFonts([]);
    setReplacements({});
    setPreviewStatus("pending");
    setPreviewUrl(null);
    setPreviewLoaded(false);
    setPreviewError(null);
  };

  const commitVersion = async () => {
    if (!resource || !sessionId || operationRef.current || previewStatus !== "ready" || !previewLoaded) return;
    setOperationSafe("commit");
    try {
      const result = await api<{ resource_id: number; version_no: number }>(
        "/api/resources/" + resource.id + "/versions/from-import/" + sessionId,
        { method: "POST", json: { change_note: changeNote.trim(), common_remark_html: commonRemark, inherit_personal_remarks: inheritPersonal } },
      );
      setSessionId(null);
      toast.success("v" + result.version_no + " 已创建");
      await queryClient.invalidateQueries({ queryKey: ["resources"] });
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message || "新版本保存失败");
    } finally {
      if (operationRef.current === "commit") setOperationSafe(null);
    }
  };

  const currentVersionNo = resource?.current?.version_no ?? 0;
  const nextVersionNo = currentVersionNo + 1;
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const busy = operation !== null;
  const replacementFamilies = Array.from(new Set(standardFonts.map((item) => item.family).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN"));

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="flex max-h-[92vh] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>版本迭代</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">{resource?.name || "单页素材"}</span><span>·</span><span>v{currentVersionNo}</span><span>→</span><span className="font-medium text-foreground">v{nextVersionNo}</span>
            <span className="ml-1">上传单页 PPT 后，平台会检查字体并自动生成确认图。</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid shrink-0 grid-cols-3 gap-2 border-b bg-muted/20 px-6 py-3" aria-label="版本迭代步骤">
          {STEPS.map((item, index) => {
            const active = item.id === step;
            const completed = index < stepIndex;
            return <div key={item.id} className={cn("flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm", active ? "bg-background font-medium shadow-sm" : completed ? "text-foreground" : "text-muted-foreground")}><span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[11px]", active ? "bg-primary text-primary-foreground" : "bg-muted")}>{completed ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}</span>{item.label}</div>;
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === "upload" && <div className="grid gap-5">
            <section className="grid gap-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-4"><div><h3 className="text-sm font-medium">新版 PPT</h3><p className="mt-1 text-xs text-muted-foreground">只允许 1 页；预览图由后台统一渲染，不需要也不能手工上传。</p></div>{pptFile && <span className="shrink-0 text-xs text-muted-foreground">{formatSize(pptFile.size)}</span>}</div>
              <FilePickerCard id="new-version-ppt" label="单页 PPT 文件" accept=".pptx,.potx,.ppsx" file={pptFile} icon={<FileText className="h-4 w-4" />} onChange={handlePptChange} />
              {fileError && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{fileError}</p>}
              {operation === "upload" && <div className="space-y-2"><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: Math.min(100, Math.max(2, uploadProgress)) + "%" }} /></div><p className="text-xs text-muted-foreground">正在上传并检查 PPT… {Math.round(uploadProgress)}%</p></div>}
            </section>
            <section className="grid gap-2"><Label htmlFor="new-version-note">版本说明（必填）</Label><Input id="new-version-note" value={changeNote} maxLength={500} onChange={(event) => setChangeNote(event.target.value)} placeholder="说明本次更新了什么，例如：更新数据并调整标题布局" /><div className="text-right text-[11px] text-muted-foreground">{changeNote.length} / 500</div></section>
            <section className="grid gap-2"><div className="flex items-center justify-between gap-3"><Label>新版通用备注</Label><span className="text-xs text-muted-foreground">默认带入上一版，可直接修改</span></div><RichTextEditor value={commonRemark} onChange={setCommonRemark} placeholder="填写对所有可见用户展示的备注" minHeight={130} /></section>
            <section className="flex items-start gap-3 rounded-lg border p-4"><Checkbox id="inherit-personal-version" checked={inheritPersonal} onCheckedChange={(value) => setInheritPersonal(value === true)} className="mt-0.5" /><div><Label htmlFor="inherit-personal-version">继承上一版本的个人备注</Label><p className="mt-1 text-xs leading-relaxed text-muted-foreground">勾选后，各用户在 v{currentVersionNo} 的个人备注会复制到 v{nextVersionNo}。</p></div></section>
          </div>}

          {step === "fonts" && <div className="grid gap-4">
            <div><h3 className="font-medium">字体检查</h3><p className="mt-1 text-sm text-muted-foreground">平台已读取这页 PPT 的字体。非标准字体必须替换后才能生成确认图。</p></div>
            <div className={cn("rounded-lg border p-4 text-sm", missingFonts.length ? "border-amber-300 bg-amber-50 text-amber-950" : "border-green-300 bg-green-50 text-green-950")}>{missingFonts.length ? <><AlertCircle className="mr-2 inline h-4 w-4" />发现 {missingFonts.length} 个非标准字体</> : <><CheckCircle2 className="mr-2 inline h-4 w-4" />字体检查通过，正在自动生成高清图片</>}</div>
            {standardFontsError && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{standardFontsError}</p>}
            {missingFonts.length > 0 ? <div className="grid gap-3 rounded-lg border p-4">{missingFonts.map((font) => <div key={font} className="grid items-center gap-2 sm:grid-cols-[1fr_1.5fr]"><div><div className="text-sm font-medium">{font}</div><div className="text-xs text-amber-700">非标准字体</div></div><Select disabled={busy || standardFontsLoading || Boolean(standardFontsError)} value={replacements[font] || ""} onValueChange={(value) => setReplacements((old) => ({ ...old, [font]: value }))}><SelectTrigger aria-label={"替换字体 " + font}><SelectValue placeholder={standardFontsLoading ? "正在加载标准字体…" : "选择替换字体"} /></SelectTrigger><SelectContent>{replacementFamilies.filter((family) => family !== font).map((family) => <SelectItem key={family} value={family}>{family}</SelectItem>)}</SelectContent></Select></div>)}</div> : fonts.length > 0 ? <div className="flex flex-wrap gap-2 rounded-lg border p-4">{fonts.map((font) => <span key={font} className="rounded-md bg-muted px-2 py-1 text-xs">{font}</span>)}</div> : null}
          </div>}

          {step === "preview" && <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
            <section className="overflow-hidden rounded-xl border bg-muted/20"><div className="flex aspect-video items-center justify-center bg-black/[0.03]">{previewStatus === "rendering" ? <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground"><Loader2 className="h-8 w-8 animate-spin" /><span>{renderMessage || "后台正在转换 PPT 为高清图片…"}</span></div> : previewStatus === "error" ? <div className="max-w-md p-6 text-center"><AlertCircle className="mx-auto h-8 w-8 text-destructive" /><p className="mt-3 text-sm font-medium">图片生成失败</p><p className="mt-1 text-sm text-muted-foreground">{previewError}</p><Button type="button" variant="outline" className="mt-4" onClick={() => sessionId && void generatePreview(sessionId)}><RefreshCw className="mr-1.5 h-4 w-4" />重新生成</Button></div> : previewUrl ? <img src={previewUrl} alt="新版单页素材确认图" className="h-full w-full object-contain" onLoad={() => setPreviewLoaded(true)} onError={() => { setPreviewLoaded(false); setPreviewError("确认图加载失败，请重新生成"); }} /> : <span className="text-sm text-muted-foreground">等待后台图片</span>}</div><div className="flex items-center justify-between border-t bg-background px-4 py-3"><span className="text-xs text-muted-foreground">请重点核对文字、字体替换、图片和版式</span>{previewUrl && <Button type="button" variant="ghost" size="sm" onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}><ExternalLink className="mr-1 h-3.5 w-3.5" />打开原图</Button>}</div></section>
            <aside className="grid content-start gap-4 rounded-xl border bg-card p-4"><div><h3 className="font-medium">确认新版本</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">只有点击“确认创建”后，v{nextVersionNo} 才会正式生效。</p></div><dl className="grid gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">源文件</dt><dd className="mt-1 break-all font-medium">{pptFile?.name || "-"}</dd></div><div><dt className="text-xs text-muted-foreground">版本说明</dt><dd className="mt-1 leading-relaxed">{changeNote}</dd></div><div><dt className="text-xs text-muted-foreground">字体检查</dt><dd className="mt-1">已通过，共 {fonts.length} 种字体</dd></div><div><dt className="text-xs text-muted-foreground">个人备注</dt><dd className="mt-1">{inheritPersonal ? "继承上一版本" : "新版为空"}</dd></div></dl><Button type="button" variant="outline" size="sm" onClick={() => void restartUpload()} disabled={busy}><Upload className="mr-1.5 h-3.5 w-3.5" />重新上传 PPT</Button></aside>
          </div>}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background px-6 py-4"><span className="text-xs text-muted-foreground">第 {stepIndex + 1} / {STEPS.length} 步 · {STEPS[stepIndex].label}</span><div className="flex items-center gap-2"><Button type="button" variant="outline" onClick={() => requestClose(false)} disabled={operation === "upload" || operation === "commit"}>取消</Button>{step === "upload" && <Button type="button" onClick={() => void uploadAndCheck()} disabled={busy || !resource || !pptFile || !changeNote.trim()}>{operation === "upload" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}{operation === "upload" ? "上传检查中…" : "上传并检查"}</Button>}{step === "fonts" && missingFonts.length > 0 && <Button type="button" onClick={() => void replaceFonts()} disabled={busy || standardFontsLoading || Boolean(standardFontsError) || missingFonts.some((font) => !replacements[font])}>{operation === "replace" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}替换字体并生成图片</Button>}{step === "preview" && <Button type="button" onClick={() => void commitVersion()} disabled={busy || previewStatus !== "ready" || !previewLoaded}>{operation === "commit" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{operation === "commit" ? "正在保存…" : "确认创建 v" + nextVersionNo}</Button>}</div></div>
      </DialogContent>
    </Dialog>
  );
}
