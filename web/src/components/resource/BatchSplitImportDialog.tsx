import { useNewFormDefaults } from "@/lib/tag-defaults";
import * as React from "react";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, Loader2, RefreshCw, Upload, UploadCloud, X } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagInput } from "@/components/resource/TagInput";
import { MetadataTagSelect } from "@/components/resource/MetadataTagSelect";
import { EMPTY_SHOW_DRAFT, ImportShowOption, type ShowDraft } from "@/components/resource/ImportShowOption";
import { ImportDuplicatePanel, type DuplicateAction, type DuplicateChoice, type DuplicatesResponse } from "@/components/resource/ImportDuplicatePanel";
import { UserPicker } from "@/components/resource/UserPicker";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import {
  DEFAULT_RESOURCE_SUBJECT,
  MANAGEMENT_SCOPE_OPTIONS,
  TEMPLATE_PLATFORM_OPTIONS,
  TEMPLATE_RATIO_OPTIONS,
  TEMPLATE_TYPE_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { ApiError, api, apiNdjson, apiUploadWithProgress, uploadErrorMessage } from "@/lib/api";
import { setAutomaticReloadBlocked } from "@/lib/deployment-recovery";
import { parsePreviewRenderEvent } from "@/lib/resourceImportStream";
import { releaseImportSession, rememberPendingImport, forgetPendingImport } from "@/lib/resourceImportLifecycle";
import { FontItem, parseTags, serializeTags } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ResourceImportWizardProps {
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  onShowCreated?: (show: { id: number; name: string }) => void;
  ownerId?: number;
  taskId?: number;
  onTaskCreated?: (taskId: number) => void;
  target?: "resources" | "templates";
}
type Step = "upload" | "fonts" | "render" | "duplicates" | "confirm";
type Operation = "upload" | "replace" | "render" | "commit" | null;
type PreviewStatus = "pending" | "blocked" | "ready" | "error" | "rendering";
type CommitProgress = { status: "processing" | "completed" | "failed"; progress: number; total: number; message: string };
type ScopeValue = "public" | "partial" | "private";
const STEPS: { id: Step; label: string }[] = [{ id: "upload", label: "上传与信息" }, { id: "fonts", label: "字体检测" }, { id: "render", label: "图片渲染" }, { id: "duplicates", label: "重复检查" }, { id: "confirm", label: "确认导入" }];
const PPT_EXTENSIONS = new Set([".pptx", ".potx", ".ppsx"]);
const PPT_FORMAT_HINT = "仅支持 PPTX/POTX/PPSX；旧版 PPT/POT/PPS 请先在 PowerPoint 或 WPS 中另存为 PPTX";
const MIB = 1024 * 1024;
const MAX_PPT_BYTES = 10 * 1024 * MIB;
const PREVIEW_PAGE_SIZE = 12;
const parseStoredStringList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  } catch {
    // Compatibility with tasks created before tag grants were stored as JSON.
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
};
const parseStoredIdList = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.map(Number).filter((item) => Number.isInteger(item) && item > 0);
  return parseStoredStringList(value).map(Number).filter((item) => Number.isInteger(item) && item > 0);
};
const formatSize = (bytes: number) => bytes >= 1024 * MIB ? `${(bytes / (1024 * MIB)).toFixed(2)} GB` : `${(bytes / MIB).toFixed(1)} MB`;

export function ResourceImportWizard({ onOpenChange, onSuccess, onShowCreated, ownerId, taskId: initialTaskId, onTaskCreated, target = "resources" }: ResourceImportWizardProps) {
  const templateMode = target === "templates";
  const steps = React.useMemo(() => templateMode ? STEPS.filter((item) => item.id !== "duplicates") : STEPS, [templateMode]);
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
  const [previewIndex, setPreviewIndex] = React.useState<number | null>(null);
  const previewTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const previewCloseRef = React.useRef<HTMLButtonElement>(null);
  const [previewLoads, setPreviewLoads] = React.useState<Record<number, "loaded" | "error">>({});
  const [previewRetries, setPreviewRetries] = React.useState<Record<number, number>>({});
  const [renderMessage, setRenderMessage] = React.useState("");
  const [renderStartedAt, setRenderStartedAt] = React.useState<number | null>(null);
  const [renderElapsedSeconds, setRenderElapsedSeconds] = React.useState(0);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [dragActive, setDragActive] = React.useState(false);
  const [metadataError, setMetadataError] = React.useState<string | null>(null);
  const [taskError, setTaskError] = React.useState<string | null>(null);
  const [workflowState, setWorkflowState] = React.useState("");
  const [operation, setOperation] = React.useState<Operation>(null);
  const [progress, setProgress] = React.useState(0);
  const [uploadLoaded, setUploadLoaded] = React.useState(0);
  const [uploadTotal, setUploadTotal] = React.useState(0);
  const [createdCount, setCreatedCount] = React.useState<number | null>(null);
  const [uploadUncertain, setUploadUncertain] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [commitProgress, setCommitProgress] = React.useState<CommitProgress | null>(null);
  const [duplicateStatus, setDuplicateStatus] = React.useState<"idle" | "checking" | "warming" | "ready" | "error">("idle");
  const [duplicateData, setDuplicateData] = React.useState<DuplicatesResponse | null>(null);
  const [duplicateError, setDuplicateError] = React.useState<string | null>(null);
  const [duplicateSkipped, setDuplicateSkipped] = React.useState(false);
  const [duplicateChoices, setDuplicateChoices] = React.useState<Record<number, DuplicateChoice>>({});
  const duplicateTouchedRef = React.useRef<Set<number>>(new Set());
  const [reusedCount, setReusedCount] = React.useState(0);
  const [namePrefix, setNamePrefix] = React.useState("");
  const nameEditedRef = React.useRef(false);
  const [subject, setSubject] = React.useState(DEFAULT_RESOURCE_SUBJECT);
  const [status, setStatus] = React.useState("");
  const [tagList, setTagList] = React.useState<string[]>([]);
  const markDefaultsTouched = useNewFormDefaults("resource_create", (defaults) => {
    setSubject(defaults.subject || "");
    setStatus(defaults.status || "");
    setTagList(defaults.resource_tags ?? []);
  }, templateMode || Boolean(initialTaskId) || Boolean(taskId));
  const [visibilityScope, setVisibilityScope] = React.useState<ScopeValue | "">("");
  const [managementScope, setManagementScope] = React.useState<ScopeValue | "">("");
  const [scopePicker, setScopePicker] = React.useState<"visibility" | "management" | null>(null);
  const [visibleUserIds, setVisibleUserIds] = React.useState<number[]>([]);
  const [visibleUserTags, setVisibleUserTags] = React.useState<string[]>([]);
  const [manageUserIds, setManageUserIds] = React.useState<number[]>([]);
  const [manageUserTags, setManageUserTags] = React.useState<string[]>([]);
  const [remarkHtml, setRemarkHtml] = React.useState("");
  const [templateSeries, setTemplateSeries] = React.useState("");
  const [templatePlatform, setTemplatePlatform] = React.useState("wps");
  const [templateRatio, setTemplateRatio] = React.useState("16:9");
  const [templateType, setTemplateType] = React.useState("content");
  const mountedRef = React.useRef(false);
  const sessionRef = React.useRef<string | null>(null);
  const taskOwnedRef = React.useRef(Boolean(initialTaskId));
  const operationRef = React.useRef<Operation>(null);
  const renderAbortRef = React.useRef<AbortController | null>(null);
  const renderErrorRef = React.useRef(false);
  const uploadingRef = React.useRef(false);
  const commitCompletedRef = React.useRef(false);
  const onSuccessRef = React.useRef(onSuccess);
  const [showEnabled, setShowEnabled] = React.useState(false);
  const [showDraft, setShowDraft] = React.useState<ShowDraft>(EMPTY_SHOW_DRAFT);
  const [showError, setShowError] = React.useState<string | null>(null);
  const [showCreating, setShowCreating] = React.useState(false);
  const [createdShow, setCreatedShow] = React.useState<{ id: number; name: string } | null>(null);
  const [showRetryIds, setShowRetryIds] = React.useState<number[] | null>(null);
  const showCreatingRef = React.useRef(false);
  const showDraftSeededRef = React.useRef(false);
  const showNameEditedRef = React.useRef(false);
  const onShowCreatedRef = React.useRef(onShowCreated);
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
  const stepIndex = steps.findIndex((item) => item.id === step);
  const setOperationSafe = (value: Operation) => {
    operationRef.current = value;
    setOperation(value);
  };
  const startOperation = (value: Exclude<Operation, null>): boolean => {
    // React state is committed after the event handler returns. The ref closes
    // that same-tick window so double clicks cannot enqueue duplicate work.
    if (operationRef.current !== null) return false;
    setOperationSafe(value);
    return true;
  };
  const getPreviewUrl = (index: number) => { const base = previewUrls[index] || `/api/resource-import/${sessionId}/preview/${index}`; return `${base}${base.includes("?") ? "&" : "?"}retry=${previewRetries[index] || 0}`; };
  onSuccessRef.current = onSuccess;
  onShowCreatedRef.current = onShowCreated;
  const completeCommit = React.useCallback((completedSessionId: string, created: number, message = "导入完成") => {
    if (commitCompletedRef.current) return;
    commitCompletedRef.current = true;
    if (!templateMode) forgetPendingImport(ownerId, completedSessionId);
    sessionRef.current = null;
    setSessionId(null);
    setCreatedCount(created);
    setCommitProgress({ status: "completed", progress: created, total: created, message });
    onSuccessRef.current?.();
    toast.success(`已导入 ${created} 个${templateMode ? "标准模板" : "单页素材"}`);
  }, [ownerId, templateMode]);

  const seedShowDraft = (): ShowDraft => ({
    ...EMPTY_SHOW_DRAFT,
    name: (namePrefix || pptFile?.name.replace(/\.[^.]+$/, "") || "").trim(),
    subject,
    status,
    tagList: [...tagList],
    visibilityScope,
    managementScope,
    visibleUserIds: [...visibleUserIds],
    visibleUserTags: [...visibleUserTags],
    manageUserIds: [...manageUserIds],
    manageUserTags: [...manageUserTags],
  });

  const toggleShowOption = (enabled: boolean) => {
    setShowEnabled(enabled);
    setShowError(null);
    if (enabled && !showDraftSeededRef.current) {
      showDraftSeededRef.current = true;
      showNameEditedRef.current = false;
      setShowDraft(seedShowDraft());
    }
  };

  // Until the user edits the show name, keep it aligned with the resource name
  // that can still be changed at the confirmation step.
  React.useEffect(() => {
    if (!showEnabled || showNameEditedRef.current) return;
    setShowDraft((current) => current.name === namePrefix ? current : { ...current, name: namePrefix });
  }, [showEnabled, namePrefix]);

  const validateShowDraft = (): string | null => {
    const name = showDraft.name.trim();
    if (!name) return "请填写放映名称";
    if (name.length > 200) return "放映名称不能超过 200 个字符";
    if (!showDraft.visibilityScope) return "请选择放映可见范围";
    if (!showDraft.managementScope) return "请选择放映管理范围";
    if (showDraft.visibilityScope === "partial" && !showDraft.visibleUserIds.length && !showDraft.visibleUserTags.length) {
      return "放映可见范围为部分时请至少选择一位用户或一个用户标签";
    }
    if (showDraft.managementScope === "partial" && !showDraft.manageUserIds.length && !showDraft.manageUserTags.length) {
      return "放映管理范围为部分时请至少选择一位用户或一个用户标签";
    }
    if (serializeTags(showDraft.tagList).length > 2000) return "放映标签总长度不能超过 2000 个字符";
    return null;
  };

  const createShowForImport = async (resourceIds: number[]) => {
    if (showCreatingRef.current) return;
    if (operationRef.current !== null && operationRef.current !== "commit") return;
    showCreatingRef.current = true;
    setShowCreating(true);
    setShowError(null);
    setShowRetryIds(resourceIds);
    setCommitProgress((current) => current ? { ...current, message: "单页素材已保存，正在创建放映素材…" } : current);
    try {
      const result = await api<{ show: { id: number; name: string } }>("/api/shows", {
        method: "POST",
        json: {
          name: showDraft.name.trim(),
          subject: showDraft.subject.trim(),
          tags: serializeTags(showDraft.tagList),
          status: showDraft.status,
          visibility_scope: showDraft.visibilityScope,
          management_scope: showDraft.managementScope,
          visible_user_ids: showDraft.visibleUserIds,
          visible_user_tags: showDraft.visibleUserTags,
          manage_user_ids: showDraft.manageUserIds,
          manage_user_tags: showDraft.manageUserTags,
          resource_ids: resourceIds,
          change_note: "由单页素材导入创建",
        },
      });
      setCreatedShow(result.show);
      setShowRetryIds(null);
      onShowCreatedRef.current?.(result.show);
      toast.success(`已创建放映素材《${result.show.name}》`);
    } catch (error) {
      // The resources are already committed; surface the failure and let the
      // user retry creating the show without re-importing the PPT.
      setShowError((error as Error).message || "放映素材创建失败，请稍后重试");
    } finally {
      showCreatingRef.current = false;
      setShowCreating(false);
    }
  };

  const validateMetadata = () => {
    let error: string | null = null;
    if (templateMode && !templateSeries.trim()) error = "请填写模板系列";
    else if (!templateMode && !namePrefix.trim()) error = "请填写素材名称";
    else if (!templateMode && namePrefix.trim().length > 120) error = "素材名称不能超过 120 个字符";
    else if (templateMode && !subject.trim()) error = "请填写模板主体";
    else if (/[,，;；\n\r]/.test(templateMode ? templateSeries : subject)) error = templateMode ? "系列只能填写一个" : "主体只能填写一个，不能包含逗号、分号或换行";
    else if (templateMode && /[,，;；\n\r]/.test(subject)) error = "主体只能填写一个";
    else if (!templateMode && !status) error = "请选择状态";
    else if (!templateMode && serializeTags(tagList).length > 2000) error = "标签总长度不能超过 2000 个字符";
    else if (!templateMode && remarkHtml.length > 100000) error = "备注内容过长，请精简后继续";
    else if (!visibilityScope) error = "请选择可见范围";
    else if (!managementScope) error = "请选择管理范围";
    else if (visibilityScope === "partial" && !visibleUserIds.length && !visibleUserTags.length) error = "可见范围为部分时请至少选择一位用户或一个用户标签";
    else if (managementScope === "partial" && !manageUserIds.length && !manageUserTags.length) error = "管理范围为部分时请至少选择一位用户或一个用户标签";
    setMetadataError(error); if (error) toast.error(error); return !error;
  };

  React.useEffect(() => {
    mountedRef.current = true;
    // A new frontend deployment must not reload this page between upload,
    // font confirmation, render-task creation, and commit. The task URL makes
    // server-side work resumable, but form state and an as-yet-unsubmitted
    // render intent still live only in this tab.
    setAutomaticReloadBlocked("resource-import-workflow", true);
    const loadFonts = async () => { try { const result = await api<{ fonts: FontItem[] }>("/api/fonts"); if (mountedRef.current) setStandardFonts([...new Map((result.fonts || []).map((font) => [font.family, font])).values()]); } catch { if (mountedRef.current) setStandardFontsError("标准字体库加载失败，请重试后核对字体。"); } finally { if (mountedRef.current) setStandardFontsLoading(false); } };
    void loadFonts();
    return () => {
      mountedRef.current = false;
      renderAbortRef.current?.abort();
      if (sessionRef.current && !taskOwnedRef.current && !uploadingRef.current) void releaseImportSession(sessionRef.current);
      setAutomaticReloadBlocked("resource-import-workflow", false);
    };
  }, []);
  React.useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [step]);
  React.useEffect(() => { setPreviewIndex(null); }, [step, sessionId]);
  React.useEffect(() => {
    if (operation !== "upload") return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const preventEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", preventUnload);
    window.addEventListener("keydown", preventEscape, true);
    return () => {
      window.removeEventListener("beforeunload", preventUnload);
      window.removeEventListener("keydown", preventEscape, true);
    };
  }, [operation]);
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
    if (templateMode || step !== "duplicates" || !sessionId || !previewsReviewed || duplicateSkipped) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      if (cancelled) return;
      setDuplicateStatus((current) => (current === "ready" ? current : "checking"));
      setDuplicateError(null);
      try {
        const result = await api<DuplicatesResponse>(`/api/resource-import/${sessionId}/duplicates`, { method: "POST" });
        if (cancelled) return;
        if (!Array.isArray(result.items) || (result.status !== "ready" && result.status !== "warming")) {
          throw new Error("查重服务返回格式不正确");
        }
        setDuplicateData(result);
        setDuplicateStatus(result.status === "ready" ? "ready" : "warming");
        setDuplicateChoices((previous) => {
          const next = { ...previous };
          const touched = duplicateTouchedRef.current;
          for (const item of result.items ?? []) {
            if (touched.has(item.index)) continue;
            const best = item.matches[0];
            const needsReview = best?.content_changed || best?.text_state === "changed" || best?.text_state === "uncompared";
            next[item.index] = needsReview
              ? { action: "new", resourceId: null }
              : { action: "reuse", resourceId: best?.resource_id ?? null };
          }
          return next;
        });
        if (result.status !== "ready") timer = setTimeout(run, 800);
      } catch (error) {
        if (cancelled) return;
        setDuplicateError((error as Error).message || "查重失败");
        setDuplicateStatus("error");
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [templateMode, step, sessionId, previewsReviewed, duplicateSkipped]);

  React.useEffect(() => {
    setDuplicateStatus("idle");
    setDuplicateData(null);
    setDuplicateError(null);
    setDuplicateSkipped(false);
    setDuplicateChoices({});
    duplicateTouchedRef.current.clear();
    setReusedCount(0);
  }, [sessionId]);

  const duplicatesReady = templateMode || duplicateSkipped || duplicateStatus === "ready" || duplicateStatus === "error";
  const duplicateCounts = React.useMemo(() => {
    const counts: Record<DuplicateAction, number> = { reuse: 0, iterate: 0, overwrite: 0, new: 0 };
    for (const item of duplicateData?.items ?? []) {
      const choice = duplicateChoices[item.index];
      if (choice) counts[choice.action] += 1;
    }
    return counts;
  }, [duplicateData, duplicateChoices]);
  const applyAllDuplicates = (action: DuplicateAction) => {
    const next: Record<number, DuplicateChoice> = {};
    for (const item of duplicateData?.items ?? []) {
      duplicateTouchedRef.current.add(item.index);
      next[item.index] = { action, resourceId: action === "new" ? null : item.matches[0]?.resource_id ?? null };
    }
    setDuplicateChoices(next);
  };

  React.useEffect(() => {
    if (previewStatus !== "rendering" || !renderStartedAt) return;
    const timer = window.setInterval(() => setRenderElapsedSeconds(Math.floor((Date.now() - renderStartedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [previewStatus, renderStartedAt]);

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
        if (typeof p.name_prefix === "string" && !nameEditedRef.current) setNamePrefix(p.name_prefix); if (typeof p.series === "string") setTemplateSeries(p.series); if (typeof p.subject === "string") setSubject(p.subject); if (typeof p.tags === "string") setTagList(parseTags(p.tags));
        if (typeof p.platform === "string") setTemplatePlatform(p.platform); if (typeof p.ratio === "string") setTemplateRatio(p.ratio); if (typeof p.template_type === "string") setTemplateType(p.template_type);
        if (typeof p.status === "string" && p.status.trim()) setStatus(p.status);
        if (p.visibility_scope === "public" || p.visibility_scope === "partial" || p.visibility_scope === "private") setVisibilityScope(p.visibility_scope); if (p.management_scope === "public" || p.management_scope === "partial" || p.management_scope === "private") setManagementScope(p.management_scope);
        setVisibleUserIds(parseStoredIdList(p.visible_user_ids)); setManageUserIds(parseStoredIdList(p.manage_user_ids)); setVisibleUserTags(parseStoredStringList(p.visible_user_tags)); setManageUserTags(parseStoredStringList(p.manage_user_tags)); if (typeof p.remark_html === "string") setRemarkHtml(p.remark_html);
        if (typeof p.slide_count === "number") setSlideCount(p.slide_count); if (Array.isArray(p.fonts)) setFonts(p.fonts.filter((value): value is string => typeof value === "string")); if (Array.isArray(p.missing_fonts)) setMissingFonts(p.missing_fonts.filter((value): value is string => typeof value === "string"));
        if (typeof p.workflow_state === "string" && !(renderErrorRef.current && p.workflow_state === "rendering")) setWorkflowState(p.workflow_state);
        if (p.preview_status === "ready") {
          setPreviewStatus("ready");
          renderErrorRef.current = false;
          setRenderStartedAt(null);
          setRenderMessage(`全部 ${typeof p.slide_count === "number" ? p.slide_count : slideCount} 页已生成，请核对图片效果`);
          // The durable task status is authoritative. A browser stream can
          // remain open after a proxy/network interruption even though the
          // Windows worker has already completed, so stop that stale stream.
          renderAbortRef.current?.abort();
        } else if (!renderErrorRef.current && (p.preview_status === "blocked" || p.preview_status === "error" || p.preview_status === "pending")) {
          setPreviewStatus(p.preview_status);
        }
        if (p.preview_status === "rendering" && !renderErrorRef.current) {
          setPreviewStatus("rendering");
          setRenderStartedAt((value) => value ?? Date.now());
        }
        if (p.preview_status !== "ready" && !renderErrorRef.current && Number.isInteger(p.render_completed) && Number.isInteger(p.render_total)) {
          const completed = Number(p.render_completed);
          const total = Number(p.render_total);
          if (total >= 0 && completed >= 0 && completed <= total) {
            setRenderMessage(`已完成 ${completed} / ${total} 页`);
          }
        }
        if (typeof p.preview_error === "string" && p.preview_error.trim()) setPreviewError(p.preview_error); else if (p.preview_error === null || p.preview_status === "ready") setPreviewError(null);
        if (task.status === "failed") { setTaskError(task.error_message || task.message || "上传任务处理失败"); setWorkflowState("failed"); } if (task.status === "completed" && task.result_data?.created) setCreatedCount(task.result_data.created);
        if (autoNavigateRef.current) {
          if (p.workflow_state === "awaiting_confirmation" && step !== "confirm" && step !== "duplicates") setStep("render");
          else if ((p.workflow_state === "rendering" || p.workflow_state === "awaiting_render") && step !== "render" && step !== "confirm" && step !== "duplicates") setStep("render");
        }
        if (!["completed", "failed", "cancelled"].includes(task.status)) timer = setTimeout(poll, 2000);
      } catch (error) { if (!cancelled && error instanceof ApiError && error.status === 404) setTaskError("任务不存在或已被删除"); if (!cancelled) timer = setTimeout(poll, 4000); }
    };
    void poll(); return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [taskId, step, pptFile]);

  React.useEffect(() => {
    if (!sessionId || (operation !== "commit" && commitProgress?.status !== "processing")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api<{ status: "ready" | "processing" | "completed"; created?: number; progress?: number; total?: number; message?: string }>(`/api/resource-import/${sessionId}/status`);
        if (cancelled) return;
        if (result.status === "completed") {
          const created = Number(result.created || result.total || 0);
          completeCommit(sessionId, created, result.message || "导入完成");
          return;
        }
        const total = Math.max(0, Number(result.total || slideCount || 0));
        const current = Math.min(total, Math.max(0, Number(result.progress || 0)));
        setCommitProgress({ status: "processing", progress: current, total, message: result.message || "该导入会话正在处理中，请稍候…" });
        timer = setTimeout(poll, 1000);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
          setCommitProgress({ status: "failed", progress: 0, total: slideCount, message: error.status === 410 ? "导入会话已过期，请重新上传" : "导入会话已结束，请查询任务结果" });
          return;
        }
        timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [commitProgress?.status, completeCommit, operation, sessionId, slideCount]);

  const handlePptChange = (file: File | null) => {
    const suffix = file ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
    const error = file && (!PPT_EXTENSIONS.has(suffix) ? PPT_FORMAT_HINT : !file.size ? "PPT 文件为空，请重新选择" : file.size > MAX_PPT_BYTES ? "PPT 文件不能超过 10 GB" : null);
    setPptFile(error ? null : file); setFileError(error);
    if (file && !error && !templateMode && (!nameEditedRef.current || !namePrefix.trim())) {
      setNamePrefix(file.name.slice(0, file.name.lastIndexOf(".")).trim());
      nameEditedRef.current = false;
    }
  };

  const createTask = async () => {
    if (operationRef.current !== null) return;
    const error = pptFile && (!PPT_EXTENSIONS.has(pptFile.name.slice(pptFile.name.lastIndexOf(".")).toLowerCase()) ? PPT_FORMAT_HINT : !pptFile.size ? "PPT 文件为空，请重新选择" : pptFile.size > MAX_PPT_BYTES ? "PPT 文件不能超过 10 GB" : null);
    if (error || !pptFile) { setFileError(error || "请选择 PPT 文件"); toast.error(error || "请选择 PPT 文件"); return; }
    if (!validateMetadata() || !startOperation("upload")) return;
    setProgress(0); setUploadLoaded(0); setUploadTotal(pptFile.size); setFileError(null); setTaskError(null);
    const form = new FormData(); form.append("ppt_file", pptFile); form.append("images", new Blob([], { type: "application/octet-stream" }), `__slide_flow_platform__-${templateMode ? "template" : status}.bin`); form.append("import_target", target); form.append("name_prefix", templateMode ? templateSeries.trim() : namePrefix.trim()); form.append("series", templateSeries.trim()); form.append("subject", subject.trim() || DEFAULT_RESOURCE_SUBJECT); form.append("platform", templatePlatform); form.append("ratio", templateRatio); form.append("template_type", templateType); form.append("tags", templateMode ? "" : serializeTags(tagList)); form.append("status", templateMode ? "active" : status); form.append("visibility_scope", visibilityScope); form.append("visible_user_ids", JSON.stringify(visibleUserIds)); form.append("visible_user_tags", JSON.stringify(visibleUserTags)); form.append("management_scope", managementScope); form.append("manage_user_ids", JSON.stringify(manageUserIds)); form.append("manage_user_tags", JSON.stringify(manageUserTags)); form.append("remark_html", templateMode ? "" : remarkHtml);
    try {
      const result = await apiUploadWithProgress<{ task_id: number; session_id: string }>(
        "/api/tasks/split-import",
        form,
        (percent, loaded, total) => {
          setProgress(percent);
          setUploadLoaded(loaded);
          setUploadTotal(total);
        },
        "POST",
      );
      if (!mountedRef.current) return;
      taskOwnedRef.current = true; autoNavigateRef.current = false; setTaskId(result.task_id); onTaskCreated?.(result.task_id); sessionRef.current = result.session_id; setSessionId(result.session_id); setStep("fonts"); toast.success("上传任务已创建，后台正在处理");
    } catch (error) {
      const message = uploadErrorMessage(error);
      setTaskError(message);
      toast.error(message);
    }
    finally { setOperationSafe(null); }
  };

  const replaceFonts = async () => {
    if (!sessionId || !selectedReplacementCount || !startOperation("replace")) return null;
    autoNavigateRef.current = false;
    try {
      const selected = Object.fromEntries(Object.entries(replacements).filter(([, value]) => value));
      const result = await api<{ fonts: string[]; missing_fonts: string[]; preview_status?: PreviewStatus }>(`/api/resource-import/${sessionId}/replace-fonts`, { method: "POST", json: selected });
      setFonts(result.fonts || []); setMissingFonts(result.missing_fonts || []); setPreviewStatus(result.preview_status || (result.missing_fonts?.length ? "blocked" : "pending")); setPreviewUrls({}); setPreviewLoads({}); setPreviewRetries({}); setReplacements({}); toast.success(result.missing_fonts?.length ? "字体替换完成，请继续处理剩余字体" : "字体替换完成，接下来生成图片");
      return result;
    } catch (error) { setTaskError((error as Error).message || "字体替换失败"); return null; }
    finally { setOperationSafe(null); }
  };

  const generatePreviews = async (force = false) => {
    if (!sessionId || (!force && (missingFonts.length || selectedReplacementCount)) || !startOperation("render")) return;
    autoNavigateRef.current = false;
    const attachToActiveRender = workflowState === "rendering" || previewStatus === "rendering";
    const controller = new AbortController(); renderAbortRef.current = controller; renderErrorRef.current = false; setPreviewStatus("rendering"); setPreviewError(null); if (!attachToActiveRender) { setPreviewUrls({}); setPreviewLoads({}); } setRenderStartedAt((value) => value ?? Date.now()); if (!renderStartedAt) setRenderElapsedSeconds(0); setRenderMessage("正在接入 Windows 图片渲染进度…");
    let completedViaStream = false;
    let terminalRenderError = false;
    let recoverableRenderError = false;
    let streamEndedWithoutCompletion = false;
    let keepTrackingInBackground = false;
    try {
      const result = await apiNdjson<unknown, { preview_status?: PreviewStatus; preview_count?: number }>(`/api/resource-import/${sessionId}/previews`, (raw) => {
        const event = parsePreviewRenderEvent(raw, sessionId, slideCount, window.location.origin);
        if (event.type === "page") setPreviewUrls((old) => ({ ...old, [event.index]: event.preview_url }));
        else if (event.type === "completed") completedViaStream = true;
        else if ((event.type === "progress" || event.type === "started" || event.type === "heartbeat") && event.message) setRenderMessage(event.message);
        else if (event.type === "error") {
          recoverableRenderError = event.recoverable;
          terminalRenderError = !event.recoverable;
          throw new Error(event.message);
        }
      }, { method: "POST", signal: controller.signal });
      const completedViaJson = result?.preview_status === "ready" && result.preview_count === slideCount;
      if (!completedViaStream && !completedViaJson) {
        streamEndedWithoutCompletion = true;
        throw new Error("渲染进度连接提前结束");
      }
      setPreviewStatus("ready"); setRenderMessage(`全部 ${slideCount} 页已生成，请核对图片效果`); toast.success("图片渲染完成");
    } catch (error) {
      if (!controller.signal.aborted) {
        const transportInterrupted = Boolean(taskId) && !terminalRenderError && (
          recoverableRenderError || streamEndedWithoutCompletion || error instanceof TypeError ||
          (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "NetworkError"))
        );
        if (transportInterrupted) {
          keepTrackingInBackground = true;
          setPreviewStatus("rendering");
          setWorkflowState("rendering");
          setRenderMessage("进度连接已中断，后台渲染仍在继续，正在通过任务状态自动恢复…");
          setPreviewError(null);
        } else {
          renderErrorRef.current = true;
          setPreviewStatus("error");
          setWorkflowState("awaiting_render");
          setRenderMessage("图片渲染已停止，可检查配置或服务后重试");
          setPreviewError((error as Error).message || "图片渲染失败，请检查 Windows 转换节点、网络或 OSS 配置后重试");
        }
      }
    }
    finally {
      if (renderAbortRef.current === controller) renderAbortRef.current = null;
      setOperationSafe(null);
      if (!keepTrackingInBackground) setRenderStartedAt(null);
    }
  };

  const commit = async () => {
    if (!sessionId || !previewsReviewed || missingFonts.length || selectedReplacementCount || operationRef.current !== null || !validateMetadata()) return;
    if (!templateMode && showEnabled) {
      const showValidation = validateShowDraft();
      if (showValidation) { setShowError(showValidation); toast.error(showValidation); return; }
    }
    if (!startOperation("commit")) return;
    commitCompletedRef.current = false; setCommitProgress({ status: "processing", progress: 0, total: slideCount, message: `正在准备保存${templateMode ? "标准模板" : "单页素材"}…` }); setUploadError(null); setUploadUncertain(false); uploadingRef.current = true; if (!templateMode) rememberPendingImport(ownerId, { sessionId, slideCount });
    try {
      const actions = Object.fromEntries(
        Object.entries(duplicateChoices).map(([index, choice]) => [
          index,
          choice.action === "new" ? { action: "new" } : { action: choice.action, resource_id: choice.resourceId },
        ]),
      );
      const result = await api<{ created: number; reused?: number; iterated?: number; overwritten?: number; resource_ids?: number[] }>(`/api/resource-import/${sessionId}/commit`, { method: "POST", json: templateMode ? { series: templateSeries.trim(), subject: subject.trim(), platform: templatePlatform, ratio: templateRatio, template_type: templateType, visibility_scope: visibilityScope, management_scope: managementScope, visible_user_ids: visibleUserIds, visible_user_tags: visibleUserTags, manage_user_ids: manageUserIds, manage_user_tags: manageUserTags } : { name_prefix: namePrefix.trim(), subject: subject.trim() || DEFAULT_RESOURCE_SUBJECT, tags: serializeTags(tagList), status, visibility_scope: visibilityScope, management_scope: managementScope, visible_user_ids: visibleUserIds, visible_user_tags: visibleUserTags, manage_user_ids: manageUserIds, manage_user_tags: manageUserTags, remark_html: remarkHtml, ...(Object.keys(actions).length > 0 ? { actions } : {}) } });
      if (result.created !== slideCount) throw new Error("服务器返回的保存数量异常，请核对任务结果");
      setReusedCount(result.reused ?? 0);
      if (!templateMode && showEnabled) {
        const resourceIds = result.resource_ids ?? [];
        if (resourceIds.length === result.created) await createShowForImport(resourceIds);
        else setShowError("服务器未返回这批素材的编号，无法自动创建放映素材；请到放映素材页手动创建。");
      }
      completeCommit(sessionId, result.created);
    } catch (error) {
      const processing = error instanceof ApiError && error.status === 409;
      const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      if (processing) {
        setCommitProgress((current) => current || { status: "processing", progress: 0, total: slideCount, message: "该导入会话正在处理中，请稍候…" });
        setUploadError(null);
      } else {
        setCommitProgress({ status: "failed", progress: 0, total: slideCount, message: (error as Error).message || "导入失败" });
        setUploadUncertain(uncertain);
        setUploadError((error as Error).message || (uncertain ? "暂时无法确认保存结果，请到任务管理核对" : "导入失败"));
      }
    }
    finally { uploadingRef.current = false; setOperationSafe(null); }
  };

  const next = async () => {
    if (operationRef.current !== null) return;
    autoNavigateRef.current = false;
    if (step === "upload") { void createTask(); return; }
    if (step === "fonts") {
      if (!sessionId || standardFontsLoading || standardFontsError) return;
      if (missingFonts.length) {
        if (!selectedReplacementCount) return;
        const result = await replaceFonts();
        if (!result || result.missing_fonts?.length) return;
        setStep("render");
        void generatePreviews(true);
        return;
      }
      setStep("render");
      void generatePreviews();
      return;
    }
    if (step === "render" && previewsReviewed) setStep(templateMode ? "confirm" : "duplicates");
    else if (step === "duplicates") setStep("confirm");
  };
  const previous = () => { if (operationRef.current === null) { autoNavigateRef.current = false; setStep(steps[Math.max(0, stepIndex - 1)].id); } };
  const close = () => {
    if (operationRef.current === "upload") {
      toast.info("文件仍在上传，请等待上传完成后再关闭页面");
      return;
    }
    renderAbortRef.current?.abort();
    onOpenChange(false);
  };
  const uploadPercent = progress >= 100 ? 100 : Math.min(99, Math.max(0, Math.floor(progress)));
  const uploadFinished = progress >= 100;
  const uploadTransferLabel = uploadTotal > 0
    ? `${formatSize(uploadLoaded)} / ${formatSize(uploadTotal)}`
    : "正在计算文件大小…";
  const renderedPageCount = previewStatus === "ready" ? slideCount : Object.keys(previewUrls).length;
  const renderPercent = slideCount > 0 ? Math.min(100, Math.round((renderedPageCount / slideCount) * 100)) : 0;
  const renderIsIndeterminate = previewStatus === "rendering" && renderedPageCount === 0;
  const renderElapsedLabel = renderElapsedSeconds >= 60
    ? `${Math.floor(renderElapsedSeconds / 60)} 分 ${renderElapsedSeconds % 60} 秒`
    : `${renderElapsedSeconds} 秒`;
  const availablePreviewIndices = Array.from({ length: slideCount }, (_, index) => index)
    .filter((index) => previewStatus === "ready" || Boolean(previewUrls[index]));
  const previewPosition = previewIndex === null ? -1 : availablePreviewIndices.indexOf(previewIndex);
  const previousPreview = availablePreviewIndices[previewPosition - 1];
  const nextPreview = previewPosition < 0 ? undefined : availablePreviewIndices[previewPosition + 1];
  const importNamePreview = slideCount === 1 ? namePrefix.trim()
    : `${namePrefix.trim()}_${String(1).padStart(Math.max(2, String(slideCount).length), "0")} ～ ${namePrefix.trim()}_${String(slideCount).padStart(Math.max(2, String(slideCount).length), "0")}`;

  return <div onChangeCapture={markDefaultsTouched} className="relative flex h-full min-h-0 flex-col bg-background"><div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-hidden">
    <header className="shrink-0"><h1 className="text-xl font-semibold tracking-tight">{templateMode ? "导入标准模板系列" : "导入单页素材"}</h1><p className="mt-1 text-sm text-muted-foreground">上传 PPT 并填写信息后，平台会在后台完成字体检测和图片渲染；{templateMode ? "每页将按 PPT 顺序保存为同一系列。" : "可留在此处继续，也可稍后从任务管理恢复。"}</p></header>
    <nav aria-label="素材导入步骤" className="shrink-0"><ol className={cn("grid gap-1 sm:gap-3", templateMode ? "grid-cols-4" : "grid-cols-5")}>{steps.map((item, index) => { const current = item.id === step; const completed = index < stepIndex || createdCount !== null; return <li key={item.id} aria-current={current ? "step" : undefined} className={cn("flex flex-col items-center gap-1.5 rounded-md border px-1 py-2 text-center text-xs sm:flex-row sm:justify-center sm:gap-2 sm:px-3 sm:text-sm", current ? "border-foreground/25 bg-primary-weak font-medium text-foreground" : completed ? "border-foreground/15 text-foreground" : "border-transparent bg-muted/40 text-muted-foreground")}><span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", current ? "bg-primary text-primary-foreground" : "bg-muted")}>{completed ? <CheckCircle2 className="h-4 w-4" /> : index + 1}</span>{item.label}</li>; })}</ol></nav>
    <div ref={contentRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-0.5 pb-1" aria-busy={busy}>
      {step === "upload" && <section className="grid min-h-full gap-4 rounded-lg border bg-muted/30 p-4"><h2 className="sr-only">1. 上传与信息</h2><div className="grid min-h-0 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]"><div className="flex min-h-0 flex-col gap-3"><label tabIndex={0} role="button" aria-controls="import-ppt-file" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); document.getElementById("import-ppt-file")?.click(); } }} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragActive(true); }} onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }} onDrop={(event) => { event.preventDefault(); setDragActive(false); if (!busy) { const file = event.dataTransfer.files?.[0] ?? null; if (file) handlePptChange(file); } }} className={cn("flex min-h-[180px] flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-background px-6 py-8 text-center outline-none transition focus-visible:ring-2 focus-visible:ring-primary", dragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary hover:bg-primary/[0.03]")}><span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary"><UploadCloud className="h-6 w-6" /></span>{pptFile ? <><span className="max-w-full truncate text-base font-medium">{pptFile.name}</span><span className="text-xs text-muted-foreground">{formatSize(pptFile.size)} · 点击或拖拽可重新选择</span></> : <><span className="text-base font-medium">{dragActive ? "松开即可选择这个 PPT" : "点击选择，或把 PPT 拖到这里"}</span><span className="text-xs text-muted-foreground">支持 PPTX / POTX / PPSX · 最大 10 GB · 最多 500 页</span><span className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-sm">选择 PPT 文件</span></>}<input id="import-ppt-file" aria-label="选择 PPT 文件" type="file" accept=".pptx,.potx,.ppsx" className="hidden" onChange={(event) => { handlePptChange(event.target.files?.[0] || null); event.currentTarget.value = ""; }} /></label>{fileError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{fileError}</p>}{taskError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{taskError}</p>}</div>
        <div className="flex min-h-0 flex-col border-t pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <h3 className="mb-3 text-sm font-medium">{templateMode ? "模板系列信息" : "素材信息"}</h3>
          {metadataError && <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{metadataError}</p>}
          {templateMode ? <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="import-template-series">系列 <span className="text-destructive">*</span></Label><Input id="import-template-series" maxLength={80} value={templateSeries} onChange={(event) => setTemplateSeries(event.target.value)} placeholder="如：产品发布会" /></div>
            <div className="grid gap-1.5"><Label htmlFor="import-template-subject">主体 <span className="text-destructive">*</span></Label><MetadataTagSelect id="import-template-subject" domain="subject" value={subject} onChange={(value) => { markDefaultsTouched(); setSubject(value); }} /></div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label>平台</Label><Select value={templatePlatform} onValueChange={setTemplatePlatform}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TEMPLATE_PLATFORM_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
            <div className="grid gap-1.5"><Label>比例</Label><Select value={templateRatio} onValueChange={setTemplateRatio}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TEMPLATE_RATIO_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
            <div className="grid gap-1.5"><Label>默认类型</Label><Select value={templateType} onValueChange={setTemplateType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TEMPLATE_TYPE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
          </div>
          </> : <><div className="grid gap-1.5">
            <Label htmlFor="import-name">素材名称 <span className="text-destructive">*</span></Label>
            <Input id="import-name" maxLength={120} value={namePrefix} onChange={(event) => { nameEditedRef.current = true; setNamePrefix(event.target.value); }} placeholder="如：产品介绍" aria-describedby="import-name-hint" />
            <p id="import-name-hint" className="text-xs text-muted-foreground">默认使用文件名，可修改。单页直接使用该名称，多页自动追加 _01、_02 等序号。</p>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="import-subject">主体</Label>
              <MetadataTagSelect id="import-subject" domain="subject" value={subject} onChange={(value) => { markDefaultsTouched(); setSubject(value); }} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-status">状态 <span className="text-destructive">*</span></Label>
              <MetadataTagSelect id="import-status" domain="status" value={status} onChange={(value) => { markDefaultsTouched(); setStatus(value); }} />
            </div>
          </div>
          <div className="mt-4 grid gap-1.5"><Label>分类标签</Label><TagInput value={tagList} onChange={(value) => { markDefaultsTouched(); setTagList(value); }} suggestions={[]} /></div>
          </>}
          <div className="mt-4 grid gap-4 sm:grid-cols-2"><div className="grid gap-1.5"><Label htmlFor="import-visibility">可见范围 <span className="text-destructive">*</span></Label><Select value={visibilityScope} onValueChange={(value) => { setVisibilityScope(value as ScopeValue); if (value === "partial" && !visibleUserIds.length && !visibleUserTags.length) setScopePicker("visibility"); }}><SelectTrigger id="import-visibility"><SelectValue placeholder="请选择可见范围" /></SelectTrigger><SelectContent>{VISIBILITY_SCOPE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1.5"><Label htmlFor="import-management">管理范围 <span className="text-destructive">*</span></Label><Select value={managementScope} onValueChange={(value) => { setManagementScope(value as ScopeValue); if (value === "partial" && !manageUserIds.length && !manageUserTags.length) setScopePicker("management"); }}><SelectTrigger id="import-management"><SelectValue placeholder="请选择管理范围" /></SelectTrigger><SelectContent>{MANAGEMENT_SCOPE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div></div>{(visibilityScope === "partial" || managementScope === "partial") && <div className={cn("mt-4 grid gap-3", visibilityScope === "partial" && managementScope === "partial" && "sm:grid-cols-2")}>{visibilityScope === "partial" && <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm"><div><p className="font-medium">可见用户或标签</p><p className="text-xs text-muted-foreground">{visibleUserIds.length || visibleUserTags.length ? `已选 ${visibleUserIds.length} 位用户、${visibleUserTags.length} 个标签` : "尚未选择，至少需要 1 项"}</p></div><Button type="button" size="sm" variant="outline" onClick={() => setScopePicker("visibility")}>选择用户/标签</Button></div>}{managementScope === "partial" && <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm"><div><p className="font-medium">管理用户或标签</p><p className="text-xs text-muted-foreground">{manageUserIds.length || manageUserTags.length ? `已选 ${manageUserIds.length} 位用户、${manageUserTags.length} 个标签` : "尚未选择，至少需要 1 项"}</p></div><Button type="button" size="sm" variant="outline" onClick={() => setScopePicker("management")}>选择用户/标签</Button></div>}</div>}{!templateMode && <div className="mt-4 flex min-h-[140px] flex-1 flex-col gap-2"><Label id="import-remark-label">通用备注</Label><RichTextEditor ariaLabelledBy="import-remark-label" value={remarkHtml} onChange={setRemarkHtml} minHeight={0} className="flex-1" /></div>}
        </div></div></section>}

      {step === "fonts" && <section className="grid gap-4 rounded-lg border p-4"><h2 className="sr-only">2. 字体检测</h2>{taskError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{taskError}</p>}{!sessionId || !fonts.length ? <div className="flex items-center gap-2 rounded-md bg-muted/40 p-4 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{sessionId ? "正在检测 PPT 页数和字体…" : "正在等待上传任务完成…"}</div> : <><p className="text-sm text-muted-foreground">共 {slideCount} 页，检测到 {fonts.length} 种字体。</p><div className={cn("rounded-md border px-3 py-2 text-sm", missingFonts.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-green-300 bg-green-50 text-green-900")}>{missingFonts.length ? <><AlertCircle className="mr-1 inline h-4 w-4" />检测到 {missingFonts.length} 个非标准字体，请替换后继续。</> : <><CheckCircle2 className="mr-1 inline h-4 w-4" />字体检测通过，请确认后继续。</>}</div><div className="space-y-3 rounded-md border bg-muted/20 p-3">{fonts.map((font) => <div key={font} className="grid items-center gap-2 sm:grid-cols-[1fr_1.5fr]"><span className={cn("break-words text-sm", missingFonts.includes(font) && "font-medium text-amber-800")}>{font}{missingFonts.includes(font) && <span className="ml-1 text-xs">（非标准字体）</span>}</span><Select disabled={busy || standardFontsLoading || !!standardFontsError} value={replacements[font] || "__keep__"} onValueChange={(value) => setReplacements((old) => { const next = { ...old }; if (value === "__keep__") delete next[font]; else next[font] = value; return next; })}><SelectTrigger aria-label={`替换字体 ${font}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__keep__">保留原字体</SelectItem>{standardFonts.filter((item) => item.family !== font).map((item) => <SelectItem key={item.id} value={item.family}>{item.family}</SelectItem>)}</SelectContent></Select></div>)}</div></>}</section>}

      {step === "render" && <section className="grid gap-4 rounded-lg border p-4">
        <h2 className="sr-only">3. 图片渲染</h2>
        {previewError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{previewError}</p>}
        {previewStatus !== "ready" && <div className="space-y-3 rounded-md border border-dashed p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => void generatePreviews()} disabled={busy || !sessionId || !!missingFonts.length}>
              <RefreshCw className={cn("mr-1 h-4 w-4", (operation === "render" || workflowState === "rendering") && "animate-spin")} />
              {operation === "render" ? "正在渲染高清图片…" : workflowState === "rendering" ? "接入后台渲染进度" : previewStatus === "error" ? "重试图片渲染" : "开始图片渲染"}
            </Button>
            {previewStatus === "rendering" && <span className="text-xs tabular-nums text-muted-foreground">已运行 {renderElapsedLabel}</span>}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={renderIsIndeterminate ? undefined : renderPercent} aria-label="图片渲染进度">
            <div className={cn("h-full rounded-full bg-primary transition-[width] duration-300", renderIsIndeterminate && "w-full animate-pulse opacity-45")} style={renderIsIndeterminate ? undefined : { width: `${renderPercent}%` }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p role="status" aria-live="polite">{renderMessage || `等待开始 ${slideCount} 页图片渲染`}</p>
            <span className="shrink-0 tabular-nums">{renderIsIndeterminate ? `整批转换中 · 共 ${slideCount} 页` : `${renderedPageCount} / ${slideCount} 页 · ${renderPercent}%`}</span>
          </div>
        </div>}
        {sessionId && (previewStatus === "ready" || Object.keys(previewUrls).length > 0) && <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p>点击图片可放大查看，支持左右切换页面。</p>
            <p className="shrink-0 tabular-nums">共 {slideCount} 页，已生成 {renderedPageCount} 页、已加载 {loadedPreviewCount} 张{failedPreviewCount ? `，${failedPreviewCount} 张加载失败` : ""}。</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: Math.min(PREVIEW_PAGE_SIZE, Math.max(0, slideCount - previewPage * PREVIEW_PAGE_SIZE)) }, (_, offset) => {
            const index = previewPage * PREVIEW_PAGE_SIZE + offset;
            const url = getPreviewUrl(index);
            const available = previewStatus === "ready" || !!previewUrls[index];
            return <div key={`${index}-${url}`} className="overflow-hidden rounded-md border bg-muted/20">
              {!available ? <div className="flex aspect-video items-center justify-center text-sm text-muted-foreground">第 {index + 1} 页等待渲染</div> : previewLoads[index] === "error" ?
                <div className="flex aspect-video flex-col items-center justify-center gap-2 text-sm text-destructive"><AlertCircle className="h-5 w-5" />第 {index + 1} 页加载失败<Button type="button" size="sm" variant="outline" onClick={() => { setPreviewLoads((old) => { const next = { ...old }; delete next[index]; return next; }); setPreviewRetries((old) => ({ ...old, [index]: (old[index] || 0) + 1 })); }}>重试</Button></div> :
                <button type="button" aria-label={`放大查看第 ${index + 1} 页`} className="block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary" onClick={(event) => { previewTriggerRef.current = event.currentTarget; setPreviewIndex(index); }}><img src={url} alt={`第 ${index + 1} 页预览`} onLoad={() => setPreviewLoads((old) => ({ ...old, [index]: "loaded" }))} onError={() => setPreviewLoads((old) => ({ ...old, [index]: "error" }))} className="aspect-video w-full object-contain" /></button>}
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">第 {index + 1} 页</p>
            </div>;
          })}</div>
          {previewPageCount > 1 && <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">第 {previewPage + 1} / {previewPageCount} 组</span><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={!previewPage} onClick={() => setPreviewPage((value) => value - 1)}>上一组</Button><Button type="button" size="sm" variant="outline" disabled={previewPage + 1 >= previewPageCount} onClick={() => setPreviewPage((value) => value + 1)}>下一组</Button></div></div>}
          {!previewsReviewed && <p className="text-xs text-amber-700">请浏览全部分页并确保图片加载成功后继续。</p>}
        </>}
      </section>}

          {step === "duplicates" && !templateMode && <section className="grid gap-4 rounded-lg border p-4"><h2 className="sr-only">4. 重复检查</h2><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p>点击图片可放大对比，支持闪烁查看差异。</p><p className="shrink-0 tabular-nums">{duplicateStatus === "checking" || duplicateStatus === "warming" ? (duplicateData?.text_remaining ? "正在补齐文字比对…" : "正在比对素材库…") : `共 ${slideCount} 页，${duplicateData?.items.length ?? 0} 页可处理`}</p></div><ImportDuplicatePanel status={duplicateStatus} data={duplicateData} error={duplicateError} skipped={duplicateSkipped} choices={duplicateChoices} pagePreviewUrl={getPreviewUrl} onChoiceChange={(index, choice) => { duplicateTouchedRef.current.add(index); setDuplicateChoices((previous) => ({ ...previous, [index]: choice })); }} onApplyAll={applyAllDuplicates} onSkip={() => setDuplicateSkipped(true)} disabled={busy || commitProgress?.status === "processing"} /></section>}
      {step === "confirm" && <section className="grid gap-4 rounded-lg border p-4"><h2 className="sr-only">{templateMode ? "4" : "5"}. 确认导入</h2>{createdCount !== null ? <div className="rounded-md border border-green-300 bg-green-50 p-5 text-green-900"><p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-5 w-5" />导入完成，已保存 {createdCount} 个{templateMode ? "标准模板" : "单页素材"}{reusedCount > 0 ? `（复用 ${reusedCount} 个已有素材）` : ""}</p>{!templateMode && createdShow && <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">已创建放映素材《{createdShow.name}》。<Button asChild size="sm" variant="outline"><Link to={`/shows/${createdShow.id}`} state={{ detailOrigin: { url: "/manage/shows", key: "", scroll: {} } }}>查看放映素材</Link></Button></p>}{!templateMode && showError && <div className="mt-2 space-y-2 text-sm text-amber-800"><p role="alert">素材已导入，但放映素材未创建：{showError}</p>{showRetryIds && !createdShow && <Button type="button" size="sm" variant="outline" disabled={showCreating} onClick={() => { if (!showCreating && showRetryIds) void createShowForImport(showRetryIds); }}>{showCreating ? "正在创建…" : "重试创建放映素材"}</Button>}</div>}</div> : <><dl className="grid gap-4 rounded-md bg-muted/30 p-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">源文件</dt><dd className="mt-1 break-all font-medium">{pptFile?.name}</dd></div><div><dt className="text-muted-foreground">{templateMode ? "模板数量" : "素材数量"}</dt><dd className="mt-1 font-medium">{slideCount} 个{templateMode ? "标准模板" : "单页素材"}</dd></div><div><dt className="text-muted-foreground">{templateMode ? "系列" : "名称"}</dt><dd className="mt-1 break-all font-medium">{templateMode ? templateSeries.trim() : <div className="space-y-2"><Input aria-label="修改素材名称" maxLength={120} value={namePrefix} disabled={busy || commitProgress?.status === "processing"} onChange={(event) => { nameEditedRef.current = true; setNamePrefix(event.target.value); }} /><p className="text-xs font-normal text-muted-foreground">{importNamePreview}</p></div>}</dd></div><div><dt className="text-muted-foreground">主体</dt><dd className="mt-1 font-medium">{subject.trim() || "未设置"}</dd></div></dl>{!templateMode && <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 p-3 text-sm"><p>{duplicateSkipped ? "已跳过查重，本批页面将全部新建。" : `重复页面处理：复用 ${duplicateCounts.reuse} · 迭代 ${duplicateCounts.iterate} · 覆盖 ${duplicateCounts.overwrite} · 新建 ${duplicateCounts.new}`}</p><Button type="button" variant="ghost" size="sm" onClick={() => setStep("duplicates")}>返回修改</Button></div>}{!templateMode && <ImportShowOption enabled={showEnabled} onEnabledChange={toggleShowOption} draft={showDraft} onDraftChange={(next) => { if (next.name !== showDraft.name) showNameEditedRef.current = true; setShowDraft(next); setShowError(null); }} disabled={busy || commitProgress?.status === "processing"} ownerId={ownerId} error={showError} />}{(operation === "commit" || commitProgress?.status === "processing") && <div className="space-y-2 rounded-md border border-primary/20 bg-primary/5 p-4" role="status" aria-live="polite"><p className="flex items-center gap-2 text-sm font-medium"><Loader2 className="h-4 w-4 animate-spin" />{commitProgress?.message || "该导入会话正在处理中，请稍候…"}</p>{(commitProgress?.total || slideCount) > 0 && <><div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={commitProgress?.total || slideCount} aria-valuenow={commitProgress?.progress || 0} aria-label="导入保存进度"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.round(((commitProgress?.progress || 0) / (commitProgress?.total || slideCount)) * 100))}%` }} /></div><p className="text-xs text-muted-foreground">已保存 {commitProgress?.progress || 0} / {commitProgress?.total || slideCount} 个{templateMode ? "标准模板" : "单页素材"}</p></>}</div>}{uploadError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{uploadError}</p>}{uploadUncertain && <p className="text-sm text-amber-700">服务器响应中断，任务可能已经保存，请到任务管理核对，不要重复导入。</p>}</>}</section>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t pt-3"><span role="status" className="text-xs text-muted-foreground">第 {stepIndex + 1} / {steps.length} 步 · {steps[stepIndex].label}</span><div className="flex flex-wrap justify-end gap-2">{createdCount !== null ? <Button type="button" onClick={close}>{templateMode ? "返回标准模板" : "返回素材库"}</Button> : <><Button type="button" variant="ghost" onClick={close} disabled={busy && operation !== "render"}><X className="mr-1 h-4 w-4" />关闭</Button>{stepIndex > 0 && <Button type="button" variant="outline" onClick={previous} disabled={busy}><ArrowLeft className="mr-1 h-4 w-4" />上一步</Button>}{step === "confirm" ? <Button type="button" onClick={commit} disabled={busy || !previewsReviewed || !!missingFonts.length || !!selectedReplacementCount || !sessionId || !duplicatesReady}><Upload className="mr-1 h-4 w-4" />{showEnabled ? "确认导入并创建放映素材" : "确认导入"}</Button> : step === "duplicates" ? <Button type="button" onClick={() => setStep("confirm")} disabled={busy || !duplicatesReady}>下一步：确认导入<ArrowRight className="ml-1 h-4 w-4" /></Button> : <Button type="button" onClick={next} disabled={busy || (step === "upload" ? !pptFile : step === "fonts" ? !sessionId || standardFontsLoading || !!standardFontsError || (!!missingFonts.length && !selectedReplacementCount) : !previewsReviewed)}>{step === "upload" ? "创建上传任务" : step === "fonts" ? (missingFonts.length ? "应用替换并下一步" : "字体已确认，下一步") : "图片已确认，下一步"}<ArrowRight className="ml-1 h-4 w-4" /></Button>}</>}</div></footer>
  </div>
    <Dialog open={scopePicker !== null} onOpenChange={(open) => { if (!open) setScopePicker(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{scopePicker === "visibility" ? "选择可见用户或用户标签" : "选择管理用户或用户标签"}</DialogTitle>
          <DialogDescription>可以按用户，也可以按用户标签授权；至少选择 1 项。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {scopePicker === "visibility" ? (
            <UserPicker value={visibleUserIds} onChange={setVisibleUserIds} tagValue={visibleUserTags} onTagChange={setVisibleUserTags} allowTagSelection lockedIds={ownerId ? [ownerId] : undefined} />
          ) : scopePicker === "management" ? (
            <UserPicker value={manageUserIds} onChange={setManageUserIds} tagValue={manageUserTags} onTagChange={setManageUserTags} allowTagSelection lockedIds={ownerId ? [ownerId] : undefined} />
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => setScopePicker(null)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={previewIndex !== null} onOpenChange={(open) => { if (!open) setPreviewIndex(null); }}>
      <DialogContent
        hideClose
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden rounded-lg p-0"
        onOpenAutoFocus={() => previewCloseRef.current?.focus()}
        onCloseAutoFocus={(event) => { event.preventDefault(); previewTriggerRef.current?.focus(); }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const index = event.key === "ArrowLeft" ? previousPreview : nextPreview;
            if (index !== undefined) setPreviewIndex(index);
          }
        }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <DialogTitle>图片预览</DialogTitle>
            <DialogDescription className="mt-1">第 {previewIndex === null ? "-" : previewIndex + 1} / {slideCount} 页 · 图片已适应窗口</DialogDescription>
          </div>
          <Button ref={previewCloseRef} type="button" variant="ghost" size="icon" aria-label="关闭图片预览" onClick={() => setPreviewIndex(null)}><X /></Button>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-neutral-950 p-2 sm:p-4">
          {previewIndex !== null && <img key={getPreviewUrl(previewIndex)} src={getPreviewUrl(previewIndex)} alt={`第 ${previewIndex + 1} 页高清预览`} className="h-full w-full object-contain" draggable={false} />}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t px-4 py-3">
          <Button type="button" variant="outline" size="sm" disabled={previousPreview === undefined} onClick={() => { if (previousPreview !== undefined) setPreviewIndex(previousPreview); }}><ArrowLeft />上一页</Button>
          <span className="hidden text-xs text-muted-foreground sm:inline">← → 切换 · Esc 关闭</span>
          <Button type="button" variant="outline" size="sm" disabled={nextPreview === undefined} onClick={() => { if (nextPreview !== undefined) setPreviewIndex(nextPreview); }}>下一页<ArrowRight /></Button>
        </footer>
      </DialogContent>
    </Dialog>
    {operation === "upload" && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="resource-upload-status-title" aria-describedby="resource-upload-status-description">
      <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Loader2 className="h-5 w-5 animate-spin" /></div>
          <div className="min-w-0 flex-1">
            <h2 id="resource-upload-status-title" className="text-lg font-semibold">正在创建上传任务</h2>
            <p id="resource-upload-status-description" role="status" aria-live="polite" className="mt-1 text-sm text-muted-foreground">{uploadFinished ? "文件已传完，正在校验文件并创建任务…" : "正在上传 PPT 文件…"}</p>
          </div>
        </div>
        <div className="mt-6 space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadPercent} aria-label="PPT 上传进度">
            <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${uploadPercent}%` }} />
          </div>
          <div className="flex items-center justify-between gap-3 text-xs tabular-nums text-muted-foreground"><span>{uploadPercent}%</span><span>{uploadTransferLabel}</span></div>
        </div>
        <p className="mt-5 rounded-md bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">上传完成前请不要关闭页面或刷新。上传完成后可以关闭，后续字体检测和图片渲染会在“任务管理”中继续。</p>
      </div>
    </div>}
  </div>;
}

export default ResourceImportWizard;
