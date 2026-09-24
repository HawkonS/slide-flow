import * as React from "react";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, FileText, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagInput } from "@/components/resource/TagInput";
import { UserPicker } from "@/components/resource/UserPicker";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import { DEFAULT_RESOURCE_SUBJECT, MANAGEMENT_SCOPE_OPTIONS, RESOURCE_STATUS_FORM_OPTIONS, SECRECY_LEVEL_FORM_OPTIONS, VISIBILITY_SCOPE_OPTIONS } from "@/lib/constants";
import { ApiError, api, apiNdjson, apiUploadWithProgress } from "@/lib/api";
import { parsePreviewRenderEvent } from "@/lib/resourceImportStream";
import { releaseImportSession, rememberPendingImport, forgetPendingImport } from "@/lib/resourceImportLifecycle";
import { FontItem, parseTags, serializeTags } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ResourceImportWizardProps { onOpenChange: (open: boolean) => void; onSuccess?: () => void; ownerId?: number; taskId?: number; }
type Step = "upload" | "fonts" | "render" | "confirm";
type Operation = "upload" | "replace" | "render" | "commit" | null;
type PreviewStatus = "pending" | "blocked" | "ready" | "error";
type ScopeValue = "public" | "partial" | "private";
const STEPS: { id: Step; label: string }[] = [{ id: "upload", label: "上传与信息" }, { id: "fonts", label: "字体检测" }, { id: "render", label: "图片渲染" }, { id: "confirm", label: "确认导入" }];
const PPT_EXTENSIONS = new Set([".pptx", ".potx", ".ppsx"]);
const PPT_FORMAT_HINT = "仅支持 PPTX/POTX/PPSX；旧版 PPT/POT/PPS 请先在 PowerPoint 或 WPS 中另存为 PPTX";
const MIB = 1024 * 1024;
const MAX_PPT_BYTES = 10 * 1024 * MIB;
const PREVIEW_PAGE_SIZE = 12;
const formatSize = (bytes: number) => bytes >= 1024 * MIB ? `${(bytes / (1024 * MIB)).toFixed(2)} GB` : `${(bytes / MIB).toFixed(1)} MB`;

export function ResourceImportWizard({ onOpenChange, onSuccess, ownerId, taskId: initialTaskId }: ResourceImportWizardProps) {
  const [step, setStep] = React.useState<Step>(initialTaskId ? "fonts" : "upload");
  const [taskId, setTaskId] = React.useState<number | null>(initialTaskId ?? null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [pptFile, setPptFile] = React.useState<File | null>(null);
  const [slideCount, setSlideCount] = React.useState(0);
  const [fonts, setFonts] = React.useState<string[]>([]);
  const [missingFonts, setMissingFonts] = React.useState<string[]>([]);
  const [replacements, setReplacements] = React.useState<Record<string, string>>({});
  const [standardFonts, setStandardFonts] = React.useState<FontItem[]>([]);
  const [standardFontsLoading, setStandardFontsLoading] = React.useState(true);
  const [standardFontsError, setStandardFontsError] = React.useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = React.useState<PreviewStatus>("pending");
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = React.useState<Record<number, string>>({});
  const [previewPage, setPreviewPage] = React.useState(0);
  const [previewLoads, setPreviewLoads] = React.useState<Record<number, "loaded" | "error">>({});
  const [previewRetries, setPreviewRetries] = React.useState<Record<number, number>>({});
  const [renderMessage, setRenderMessage] = React.useState("");
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [metadataError, setMetadataError] = React.useState<string | null>(null);
  const [taskError, setTaskError] = React.useState<string | null>(null);
  const [workflowState, setWorkflowState] = React.useState("");
  const [operation, setOperation] = React.useState<Operation>(null);
  const [progress, setProgress] = React.useState(0);
  const [createdCount, setCreatedCount] = React.useState<number | null>(null);
  const [uploadUncertain, setUploadUncertain] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [namePrefix, setNamePrefix] = React.useState("");
  const [subject, setSubject] = React.useState(DEFAULT_RESOURCE_SUBJECT);
  const [secrecyLevel, setSecrecyLevel] = React.useState<"public" | "confidential" | "secret">("public");
  const [status, setStatus] = React.useState<"active" | "disabled">("active");
  const [tagList, setTagList] = React.useState<string[]>([]);
  const [visibilityScope, setVisibilityScope] = React.useState<ScopeValue | "">("");
  const [managementScope, setManagementScope] = React.useState<ScopeValue | "">("");
  const [visibleUserIds, setVisibleUserIds] = React.useState<number[]>([]);
  const [manageUserIds, setManageUserIds] = React.useState<number[]>([]);
  const [remarkHtml, setRemarkHtml] = React.useState("");
  const mountedRef = React.useRef(false);
  const sessionRef = React.useRef<string | null>(null);
  const taskOwnedRef = React.useRef(Boolean(initialTaskId));
  const operationRef = React.useRef<Operation>(null);
  const renderAbortRef = React.useRef<AbortController | null>(null);
  const renderErrorRef = React.useRef(false);
  const uploadingRef = React.useRef(false);
  // Only a task opened from Task Management should be auto-positioned by the
  // poller. During a live import, the user owns the step navigation.
  const autoNavigateRef = React.useRef(Boolean(initialTaskId));
  const contentRef = React.useRef<HTMLDivElement>(null);
  const busy = operation !== null;
  const selectedReplacementCount = Object.values(replacements).filter(Boolean).length;
  const loadedPreviewCount = Object.values(previewLoads).filter((value) => value === "loaded").length;
  const failedPreviewCount = Object.values(previewLoads).filter((value) => value === "error").length;
  const previewsReviewed = previewStatus === "ready" && slideCount > 0 && loadedPreviewCount === slideCount;
  const previewPageCount = Math.max(1, Math.ceil(slideCount / PREVIEW_PAGE_SIZE));
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const setOperationSafe = (value: Operation) => { operationRef.current = value; setOperation(value); };
  const getPreviewUrl = (index: number) => { const base = previewUrls[index] || `/api/resource-import/${sessionId}/preview/${index}`; return `${base}${base.includes("?") ? "&" : "?"}retry=${previewRetries[index] || 0}`; };

  const validateMetadata = () => {
    let error: string | null = null;
    if (!namePrefix.trim()) error = "请填写名称前缀";
    else if (!subject.trim()) error = "请填写主体";
    else if (/[,，;；\n\r]/.test(subject)) error = "主体只能填写一个，不能包含逗号、分号或换行";
    else if (serializeTags(tagList).length > 2000) error = "标签总长度不能超过 2000 个字符";
    else if (remarkHtml.length > 100000) error = "备注内容过长，请精简后继续";
    else if (!visibilityScope) error = "请选择可见范围";
    else if (!managementScope) error = "请选择管理范围";
    else if (visibilityScope === "partial" && !visibleUserIds.length) error = "可见范围为部分时请至少选择一位用户";
    else if (managementScope === "partial" && !manageUserIds.length) error = "管理范围为部分时请至少选择一位用户";
    setMetadataError(error); if (error) toast.error(error); return !error;
  };

  React.useEffect(() => {
    mountedRef.current = true;
    const loadFonts = async () => { try { const result = await api<{ fonts: FontItem[] }>("/api/fonts"); if (mountedRef.current) setStandardFonts([...new Map((result.fonts || []).map((font) => [font.family, font])).values()]); } catch { if (mountedRef.current) setStandardFontsError("标准字体库加载失败，请重试后核对字体。"); } finally { if (mountedRef.current) setStandardFontsLoading(false); } };
    void loadFonts();
    return () => { mountedRef.current = false; renderAbortRef.current?.abort(); if (sessionRef.current && !taskOwnedRef.current && !uploadingRef.current) void releaseImportSession(sessionRef.current); };
  }, [taskId]);
  React.useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [step]);
  React.useEffect(() => {
    if (!sessionId || previewStatus !== "ready" || !slideCount) return;
    let cancelled = false;
    const images = Array.from({ length: slideCount }, (_, index) => {
      const image = new Image();
      image.onload = () => { if (!cancelled) setPreviewLoads((old) => ({ ...old, [index]: "loaded" })); };
      image.onerror = () => { if (!cancelled) setPreviewLoads((old) => ({ ...old, [index]: "error" })); };
      image.src = getPreviewUrl(index);
      return image;
    });
    return () => { cancelled = true; images.forEach((image) => { image.onload = null; image.onerror = null; image.removeAttribute("src"); }); };
  }, [sessionId, previewStatus, slideCount]);

  React.useEffect(() => {
    if (!taskId) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const task = await api<{ status: string; message?: string | null; error_message?: string | null; result_data?: { created?: number } | null; params?: Record<string, unknown> }>(`/api/tasks/${taskId}`);
        if (cancelled) return;
        const p = task.params || {};
        if (typeof p.session_id === "string") { sessionRef.current = p.session_id; setSessionId(p.session_id); }
        if (typeof p.file_name === "string" && !pptFile) setPptFile(new File([""], p.file_name));
        if (typeof p.name_prefix === "string") setNamePrefix(p.name_prefix); if (typeof p.subject === "string") setSubject(p.subject); if (typeof p.tags === "string") setTagList(parseTags(p.tags));
        if (p.secrecy_level === "public" || p.secrecy_level === "confidential" || p.secrecy_level === "secret") setSecrecyLevel(p.secrecy_level); if (p.status === "active" || p.status === "disabled") setStatus(p.status);
        if (p.visibility_scope === "public" || p.visibility_scope === "partial" || p.visibility_scope === "private") setVisibilityScope(p.visibility_scope); if (p.management_scope === "public" || p.management_scope === "partial" || p.management_scope === "private") setManagementScope(p.management_scope);
        if (typeof p.visible_user_ids === "string") setVisibleUserIds(p.visible_user_ids.split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0)); if (typeof p.manage_user_ids === "string") setManageUserIds(p.manage_user_ids.split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0)); if (typeof p.remark_html === "string") setRemarkHtml(p.remark_html);
        if (typeof p.slide_count === "number") setSlideCount(p.slide_count); if (Array.isArray(p.fonts)) setFonts(p.fonts.filter((value): value is string => typeof value === "string")); if (Array.isArray(p.missing_fonts)) setMissingFonts(p.missing_fonts.filter((value): value is string => typeof value === "string"));
        if (typeof p.workflow_state === "string" && !(renderErrorRef.current && p.workflow_state === "rendering")) setWorkflowState(p.workflow_state);
        if (p.preview_status === "ready" || p.preview_status === "blocked" || p.preview_status === "error" || p.preview_status === "pending") setPreviewStatus(p.preview_status);
        if (typeof p.preview_error === "string" && p.preview_error.trim()) setPreviewError(p.preview_error); else if (p.preview_error === null || p.preview_status === "ready") setPreviewError(null);
        if (task.status === "failed") { setTaskError(task.error_message || task.message || "上传任务处理失败"); setWorkflowState("failed"); } if (task.status === "completed" && task.result_data?.created) setCreatedCount(task.result_data.created);
        if (autoNavigateRef.current) {
          if (p.workflow_state === "awaiting_confirmation" && step !== "confirm") setStep("render");
          else if ((p.workflow_state === "rendering" || p.workflow_state === "awaiting_render") && step !== "render" && step !== "confirm") setStep("render");
        }
        if (!["completed", "failed", "cancelled"].includes(task.status)) timer = setTimeout(poll, 2000);
      } catch (error) { if (!cancelled && error instanceof ApiError && error.status === 404) setTaskError("任务不存在或已被删除"); if (!cancelled) timer = setTimeout(poll, 4000); }
    };
    void poll(); return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [taskId, step, pptFile]);

  const handlePptChange = (file: File | null) => {
    const suffix = file ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
    const error = file && (!PPT_EXTENSIONS.has(suffix) ? PPT_FORMAT_HINT : !file.size ? "PPT 文件为空，请重新选择" : file.size > MAX_PPT_BYTES ? "PPT 文件不能超过 10 GB" : null);
    setPptFile(error ? null : file); setFileError(error);
  };

  const createTask = async () => {
    const error = pptFile && (!PPT_EXTENSIONS.has(pptFile.name.slice(pptFile.name.lastIndexOf(".")).toLowerCase()) ? PPT_FORMAT_HINT : !pptFile.size ? "PPT 文件为空，请重新选择" : pptFile.size > MAX_PPT_BYTES ? "PPT 文件不能超过 10 GB" : null);
    if (error || !pptFile) { setFileError(error || "请选择 PPT 文件"); toast.error(error || "请选择 PPT 文件"); return; }
    if (!validateMetadata() || busy) return;
    setOperationSafe("upload"); setProgress(0); setFileError(null);
    const form = new FormData(); form.append("ppt_file", pptFile); form.append("images", new Blob([], { type: "application/octet-stream" }), `__slide_flow_platform__-${status}.bin`); form.append("name_prefix", namePrefix.trim()); form.append("subject", subject.trim() || DEFAULT_RESOURCE_SUBJECT); form.append("tags", serializeTags(tagList)); form.append("secrecy_level", secrecyLevel); form.append("status", status); form.append("visibility_scope", visibilityScope); form.append("visible_user_ids", visibleUserIds.join(",")); form.append("management_scope", managementScope); form.append("manage_user_ids", manageUserIds.join(",")); form.append("remark_html", remarkHtml);
    try {
      const result = await apiUploadWithProgress<{ task_id: number; session_id: string }>("/api/tasks/split-import", form, setProgress, "POST");
      if (!mountedRef.current) return;
      taskOwnedRef.current = true; autoNavigateRef.current = false; setTaskId(result.task_id); sessionRef.current = result.session_id; setSessionId(result.session_id); setStep("fonts"); toast.success("上传任务已创建，后台正在处理");
    } catch (error) { const message = (error as Error).message || "上传任务创建失败"; setTaskError(message); toast.error(message); }
    finally { setOperationSafe(null); }
  };

  const replaceFonts = async () => {
    if (!sessionId || !selectedReplacementCount || busy) return;
    autoNavigateRef.current = false;
    setOperationSafe("replace");
    try {
      const selected = Object.fromEntries(Object.entries(replacements).filter(([, value]) => value));
      const result = await api<{ fonts: string[]; missing_fonts: string[]; preview_status?: PreviewStatus }>(`/api/resource-import/${sessionId}/replace-fonts`, { method: "POST", json: selected });
      setFonts(result.fonts || []); setMissingFonts(result.missing_fonts || []); setPreviewStatus(result.preview_status || (result.missing_fonts?.length ? "blocked" : "pending")); setPreviewUrls({}); setPreviewLoads({}); setPreviewRetries({}); setReplacements({}); toast.success(result.missing_fonts?.length ? "字体替换完成，请继续处理剩余字体" : "字体替换完成，接下来生成图片");
    } catch (error) { setTaskError((error as Error).message || "字体替换失败"); }
    finally { setOperationSafe(null); }
  };

  const generatePreviews = async () => {
    if (!sessionId || busy || missingFonts.length || selectedReplacementCount || workflowState === "rendering") return;
    autoNavigateRef.current = false;
    const controller = new AbortController(); renderAbortRef.current = controller; renderErrorRef.current = false; setOperationSafe("render"); setPreviewStatus("pending"); setPreviewError(null); setPreviewUrls({}); setPreviewLoads({}); setRenderMessage("正在提交图片渲染任务，繁忙时会自动排队…");
    const received = new Set<number>();
    try {
      const result = await apiNdjson<unknown, { preview_status?: PreviewStatus; preview_count?: number }>(`/api/resource-import/${sessionId}/previews`, (raw) => { const event = parsePreviewRenderEvent(raw, sessionId, slideCount, window.location.origin); if (event.type === "page") { received.add(event.index); setPreviewUrls((old) => ({ ...old, [event.index]: event.preview_url })); setRenderMessage(`已生成 ${received.size} / ${slideCount} 页`); } else if ((event.type === "progress" || event.type === "started") && event.message) setRenderMessage(event.message); else if (event.type === "error") throw new Error(event.message); }, { method: "POST", signal: controller.signal });
      if (result?.preview_status !== "ready" || (result.preview_count !== undefined && result.preview_count !== slideCount)) throw new Error("渲染结果不完整，请重试");
      setPreviewStatus("ready"); setRenderMessage(`全部 ${slideCount} 页已生成，请核对图片效果`); toast.success("图片渲染完成");
    } catch (error) { if (!controller.signal.aborted) { renderErrorRef.current = true; setPreviewStatus("error"); setWorkflowState("awaiting_render"); setRenderMessage("图片渲染已停止，可检查配置或服务后重试"); setPreviewError((error as Error).message || "图片渲染失败，请检查 Windows 转换节点、网络或 OSS 配置后重试"); } }
    finally { renderAbortRef.current = null; setOperationSafe(null); }
  };

  const commit = async () => {
    if (!sessionId || busy || !previewsReviewed || missingFonts.length || selectedReplacementCount || !validateMetadata()) return;
    setOperationSafe("commit"); setUploadError(null); setUploadUncertain(false); uploadingRef.current = true; rememberPendingImport(ownerId, { sessionId, slideCount });
    try {
      const result = await api<{ created: number }>(`/api/resource-import/${sessionId}/commit`, { method: "POST", json: { name_prefix: namePrefix.trim(), subject: subject.trim() || DEFAULT_RESOURCE_SUBJECT, tags: serializeTags(tagList), secrecy_level: secrecyLevel, status, visibility_scope: visibilityScope, management_scope: managementScope, visible_user_ids: visibleUserIds, manage_user_ids: manageUserIds, remark_html: remarkHtml } });
      if (result.created !== slideCount) throw new Error("服务器返回的保存数量异常，请核对任务结果");
      forgetPendingImport(ownerId, sessionId); sessionRef.current = null; setSessionId(null); setCreatedCount(result.created); onSuccess?.(); toast.success(`已导入 ${result.created} 个单页素材`);
    } catch (error) { const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500; setUploadUncertain(uncertain); setUploadError((error as Error).message || (uncertain ? "暂时无法确认保存结果，请到任务管理核对" : "导入失败")); }
    finally { uploadingRef.current = false; setOperationSafe(null); }
  };

  const next = () => { if (busy) return; autoNavigateRef.current = false; if (step === "upload") void createTask(); else if (step === "fonts" && sessionId && !missingFonts.length && !selectedReplacementCount && !standardFontsLoading && !standardFontsError) setStep("render"); else if (step === "render" && previewsReviewed) setStep("confirm"); };
  const previous = () => { if (!busy) { autoNavigateRef.current = false; setStep(STEPS[Math.max(0, stepIndex - 1)].id); } };
  const close = () => { renderAbortRef.current?.abort(); onOpenChange(false); };

  return <div className="flex h-full min-h-0 flex-col bg-background"><div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-4 overflow-hidden p-4 md:p-6">
    <header className="shrink-0"><h1 className="text-xl font-semibold tracking-tight">导入单页素材</h1><p className="mt-1 text-sm text-muted-foreground">上传 PPT 并填写信息后，平台会在后台完成字体检测和图片渲染；可留在此处继续，也可稍后从任务管理恢复。</p></header>
    <nav aria-label="素材导入步骤" className="shrink-0"><ol className="grid grid-cols-4 gap-1 sm:gap-3">{STEPS.map((item, index) => { const current = item.id === step; const completed = index < stepIndex || createdCount !== null; return <li key={item.id} aria-current={current ? "step" : undefined} className={cn("flex flex-col items-center gap-1.5 rounded-md border px-1 py-2 text-center text-xs sm:flex-row sm:justify-center sm:gap-2 sm:px-3 sm:text-sm", current ? "border-foreground/25 bg-primary-weak font-medium text-foreground" : completed ? "border-foreground/15 text-foreground" : "border-transparent bg-muted/40 text-muted-foreground")}><span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", current ? "bg-primary text-primary-foreground" : "bg-muted")}>{completed ? <CheckCircle2 className="h-4 w-4" /> : index + 1}</span>{item.label}</li>; })}</ol></nav>
    <div ref={contentRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-0.5 pb-1" aria-busy={busy}>
      {step === "upload" && <section className="grid gap-4 rounded-lg border bg-muted/30 p-4"><div><h2 className="font-medium">1. 上传与信息</h2><p className="mt-1 text-sm text-muted-foreground">这里只上传 PPT，图片由平台统一渲染。创建任务后即可关闭页面，后台会继续处理。</p></div><label tabIndex={0} role="button" aria-controls="import-ppt-file" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); document.getElementById("import-ppt-file")?.click(); } }} className="flex cursor-pointer flex-col gap-1 rounded-md border border-dashed bg-background px-3 py-3 text-sm outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-primary"><span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><FileText className="h-4 w-4" />PPT 文件</span><span className="truncate font-medium">{pptFile?.name || "点击选择 PPT 文件"}</span><input id="import-ppt-file" aria-label="选择 PPT 文件" type="file" accept=".pptx,.potx,.ppsx" className="hidden" onChange={(event) => { handlePptChange(event.target.files?.[0] || null); event.currentTarget.value = ""; }} /></label>{fileError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{fileError}</p>}<p className="text-xs text-muted-foreground">{PPT_FORMAT_HINT}。PPT ≤ 10 GB、最多 500 页。{pptFile && ` 当前文件 ${formatSize(pptFile.size)}。`}</p>
        <div className="border-t pt-4"><h3 className="mb-3 text-sm font-medium">素材信息</h3>{metadataError && <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{metadataError}</p>}<div className="grid gap-1.5"><Label htmlFor="import-name">名称前缀 <span className="text-destructive">*</span></Label><Input id="import-name" maxLength={120} value={namePrefix} onChange={(event) => setNamePrefix(event.target.value)} placeholder="如：产品介绍" /></div><div className="mt-4 grid gap-4 sm:grid-cols-3"><div className="grid gap-1.5"><Label htmlFor="import-subject">主体 <span className="text-destructive">*</span></Label><Input id="import-subject" maxLength={80} value={subject} onChange={(event) => setSubject(event.target.value)} /></div><div className="grid gap-1.5"><Label htmlFor="import-secrecy">密级</Label><Select value={secrecyLevel} onValueChange={(value) => setSecrecyLevel(value as typeof secrecyLevel)}><SelectTrigger id="import-secrecy"><SelectValue /></SelectTrigger><SelectContent>{SECRECY_LEVEL_FORM_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1.5"><Label htmlFor="import-status">状态</Label><Select value={status} onValueChange={(value) => setStatus(value as typeof status)}><SelectTrigger id="import-status"><SelectValue /></SelectTrigger><SelectContent>{RESOURCE_STATUS_FORM_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div></div><div className="mt-4 grid gap-1.5"><Label>标签</Label><TagInput value={tagList} onChange={setTagList} suggestions={[]} /></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><div className="grid gap-1.5"><Label htmlFor="import-visibility">可见范围 <span className="text-destructive">*</span></Label><Select value={visibilityScope} onValueChange={(value) => setVisibilityScope(value as ScopeValue)}><SelectTrigger id="import-visibility"><SelectValue placeholder="请选择可见范围" /></SelectTrigger><SelectContent>{VISIBILITY_SCOPE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1.5"><Label htmlFor="import-management">管理范围 <span className="text-destructive">*</span></Label><Select value={managementScope} onValueChange={(value) => setManagementScope(value as ScopeValue)}><SelectTrigger id="import-management"><SelectValue placeholder="请选择管理范围" /></SelectTrigger><SelectContent>{MANAGEMENT_SCOPE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div></div>{visibilityScope === "partial" && <div className="mt-4 space-y-2"><Label>可见用户（至少选择一位）</Label><UserPicker value={visibleUserIds} onChange={setVisibleUserIds} allowTagSelection /></div>}{managementScope === "partial" && <div className="mt-4 space-y-2"><Label>管理用户（至少选择一位）</Label><UserPicker value={manageUserIds} onChange={setManageUserIds} /></div>}<div className="mt-4 grid gap-2"><Label id="import-remark-label">通用备注</Label><RichTextEditor ariaLabelledBy="import-remark-label" value={remarkHtml} onChange={setRemarkHtml} minHeight={100} /></div></div></section>}

      {step === "fonts" && <section className="grid gap-4 rounded-lg border p-4"><div><h2 className="font-medium">2. 字体检测</h2><p className="mt-1 text-sm text-muted-foreground">后台任务会先检测页数和字体；页面关闭后也会保留任务。</p></div>{taskError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{taskError}</p>}{!sessionId || !fonts.length ? <div className="flex items-center gap-2 rounded-md bg-muted/40 p-4 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{sessionId ? "正在检测 PPT 页数和字体…" : "正在等待上传任务完成…"}</div> : <><p className="text-sm text-muted-foreground">共 {slideCount} 页，检测到 {fonts.length} 种字体。</p><div className={cn("rounded-md border px-3 py-2 text-sm", missingFonts.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-green-300 bg-green-50 text-green-900")}>{missingFonts.length ? <><AlertCircle className="mr-1 inline h-4 w-4" />检测到 {missingFonts.length} 个非标准字体，请替换后继续。</> : <><CheckCircle2 className="mr-1 inline h-4 w-4" />字体检测通过，请确认后继续。</>}</div><div className="space-y-3 rounded-md border bg-muted/20 p-3">{fonts.map((font) => <div key={font} className="grid items-center gap-2 sm:grid-cols-[1fr_1.5fr]"><span className={cn("break-words text-sm", missingFonts.includes(font) && "font-medium text-amber-800")}>{font}{missingFonts.includes(font) && <span className="ml-1 text-xs">（非标准字体）</span>}</span><Select disabled={busy || standardFontsLoading || !!standardFontsError} value={replacements[font] || "__keep__"} onValueChange={(value) => setReplacements((old) => { const next = { ...old }; if (value === "__keep__") delete next[font]; else next[font] = value; return next; })}><SelectTrigger aria-label={`替换字体 ${font}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__keep__">保留原字体</SelectItem>{standardFonts.filter((item) => item.family !== font).map((item) => <SelectItem key={item.id} value={item.family}>{item.family}</SelectItem>)}</SelectContent></Select></div>)}<Button type="button" variant="outline" onClick={replaceFonts} disabled={busy || !selectedReplacementCount || standardFontsLoading || !!standardFontsError}>{operation === "replace" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{operation === "replace" ? "替换中…" : "应用字体替换"}</Button></div></>}</section>}

      {step === "render" && <section className="grid gap-4 rounded-lg border p-4"><div><h2 className="font-medium">3. 图片渲染</h2><p className="mt-1 text-sm text-muted-foreground">平台会根据已确认字体的 PPT 生成高清图片，请浏览全部页面并确认效果。</p></div>{previewError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{previewError}</p>}{previewStatus !== "ready" && <div className="space-y-3 rounded-md border border-dashed p-4"><Button type="button" variant="outline" onClick={generatePreviews} disabled={busy || !sessionId || !!missingFonts.length || workflowState === "rendering"}><RefreshCw className={cn("mr-1 h-4 w-4", operation === "render" && "animate-spin")} />{operation === "render" ? "正在渲染高清图片…" : workflowState === "rendering" ? "后台正在渲染高清图片…" : previewStatus === "error" ? "重试图片渲染" : "等待后台渲染或手动开始"}</Button><p role="status" className="text-xs text-muted-foreground">{renderMessage || `任务会在后台生成全部 ${slideCount} 页图片，生成后会自动显示。`}</p></div>}{sessionId && (previewStatus === "ready" || Object.keys(previewUrls).length > 0) && <><p className="text-sm text-muted-foreground">共 {slideCount} 张，已加载 {loadedPreviewCount} 张{failedPreviewCount ? `，${failedPreviewCount} 张加载失败` : ""}。</p><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: Math.min(PREVIEW_PAGE_SIZE, Math.max(0, slideCount - previewPage * PREVIEW_PAGE_SIZE)) }, (_, offset) => { const index = previewPage * PREVIEW_PAGE_SIZE + offset; const url = getPreviewUrl(index); const available = previewStatus === "ready" || !!previewUrls[index]; return <div key={`${index}-${url}`} className="overflow-hidden rounded-md border bg-muted/20">{!available ? <div className="flex aspect-video items-center justify-center text-sm text-muted-foreground">第 {index + 1} 页等待生成</div> : previewLoads[index] === "error" ? <div className="flex aspect-video flex-col items-center justify-center gap-2 text-sm text-destructive"><AlertCircle className="h-5 w-5" />第 {index + 1} 页加载失败<Button type="button" size="sm" variant="outline" onClick={() => { setPreviewLoads((old) => { const next = { ...old }; delete next[index]; return next; }); setPreviewRetries((old) => ({ ...old, [index]: (old[index] || 0) + 1 })); }}>重试</Button></div> : <a href={url} target="_blank" rel="noreferrer" className="block"><img src={url} alt={`第 ${index + 1} 页预览`} onLoad={() => setPreviewLoads((old) => ({ ...old, [index]: "loaded" }))} onError={() => setPreviewLoads((old) => ({ ...old, [index]: "error" }))} className="aspect-video w-full object-contain" /></a>}<p className="border-t px-3 py-2 text-xs text-muted-foreground">第 {index + 1} 页</p></div>; })}</div>{previewPageCount > 1 && <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">第 {previewPage + 1} / {previewPageCount} 组</span><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={!previewPage} onClick={() => setPreviewPage((value) => value - 1)}>上一组</Button><Button type="button" size="sm" variant="outline" disabled={previewPage + 1 >= previewPageCount} onClick={() => setPreviewPage((value) => value + 1)}>下一组</Button></div></div>}{!previewsReviewed && <p className="text-xs text-amber-700">请浏览全部分页并确保图片加载成功后继续。</p>}</>}</section>}

      {step === "confirm" && <section className="grid gap-4 rounded-lg border p-4"><h2 className="font-medium">4. 确认导入</h2>{createdCount !== null ? <div className="rounded-md border border-green-300 bg-green-50 p-5 text-green-900"><p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-5 w-5" />导入完成，已保存 {createdCount} 个单页素材</p></div> : <><p className="text-sm text-muted-foreground">字体和高清图片均已确认。确认后平台会拆分 PPT 并统一保存到素材库。</p><dl className="grid gap-4 rounded-md bg-muted/30 p-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">源文件</dt><dd className="mt-1 break-all font-medium">{pptFile?.name}</dd></div><div><dt className="text-muted-foreground">素材数量</dt><dd className="mt-1 font-medium">{slideCount} 个单页素材</dd></div><div><dt className="text-muted-foreground">名称</dt><dd className="mt-1 break-all font-medium">{namePrefix.trim()}_01 ～ {namePrefix.trim()}_{String(slideCount).padStart(2, "0")}</dd></div><div><dt className="text-muted-foreground">主体</dt><dd className="mt-1 font-medium">{subject.trim() || DEFAULT_RESOURCE_SUBJECT}</dd></div></dl>{operation === "commit" && <p role="status" className="rounded-md bg-primary/5 p-4 text-sm"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />正在拆分并保存，请稍候…</p>}{uploadError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{uploadError}</p>}{uploadUncertain && <p className="text-sm text-amber-700">服务器响应中断，任务可能已经保存，请到任务管理核对，不要重复导入。</p>}</>}</section>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t pt-3"><span role="status" className="text-xs text-muted-foreground">第 {stepIndex + 1} / {STEPS.length} 步 · {STEPS[stepIndex].label}</span><div className="flex flex-wrap justify-end gap-2">{createdCount !== null ? <Button type="button" onClick={close}>返回素材库</Button> : <><Button type="button" variant="ghost" onClick={close} disabled={busy && operation !== "render"}><X className="mr-1 h-4 w-4" />关闭</Button>{stepIndex > 0 && <Button type="button" variant="outline" onClick={previous} disabled={busy}><ArrowLeft className="mr-1 h-4 w-4" />上一步</Button>}{step === "confirm" ? <Button type="button" onClick={commit} disabled={busy || !previewsReviewed || !!missingFonts.length || !!selectedReplacementCount || !sessionId}><Upload className="mr-1 h-4 w-4" />确认导入</Button> : <Button type="button" onClick={next} disabled={busy || (step === "upload" ? !pptFile : step === "fonts" ? !sessionId || !!missingFonts.length || !!selectedReplacementCount || standardFontsLoading || !!standardFontsError : !previewsReviewed)}>{step === "upload" ? "创建上传任务" : step === "fonts" ? "字体已确认，下一步" : "图片已确认，下一步"}<ArrowRight className="ml-1 h-4 w-4" /></Button>}</>}</div></footer>
  </div></div>;
}

export default ResourceImportWizard;
