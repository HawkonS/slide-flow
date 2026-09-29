import type { PickerResource } from "@/components/show/ResourcePicker";

export interface ShowCreateFormDraft {
  name?: string;
  subject?: string;
  tagList?: string[];
  status?: string;
  visibility_scope?: string;
  management_scope?: string;
  visible_user_ids?: number[];
  visible_user_tags?: string[];
  manage_user_ids?: number[];
  manage_user_tags?: string[];
}

export interface ShowCreateDraft {
  form: ShowCreateFormDraft;
  resourceIds: number[];
  resources: PickerResource[];
  step: number;
  savedAt: string;
}

export const SHOW_CREATE_DRAFT_KEY_PREFIX = "slide-flow.show-create-draft.";

export function showCreateDraftKey(userId: number) {
  return `${SHOW_CREATE_DRAFT_KEY_PREFIX}${userId}`;
}

export function readShowCreateDraft(userId?: number): ShowCreateDraft | null {
  if (typeof userId !== "number" || userId <= 0) return null;
  try {
    const raw = localStorage.getItem(showCreateDraftKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ShowCreateDraft>;
    if (!parsed.form || !Array.isArray(parsed.resourceIds)) return null;
    return {
      form: parsed.form,
      resourceIds: parsed.resourceIds.filter((id) => Number.isInteger(id) && id > 0),
      resources: Array.isArray(parsed.resources) ? parsed.resources : [],
      step: typeof parsed.step === "number" && Number.isInteger(parsed.step)
        ? Math.max(0, Math.min(2, parsed.step))
        : 0,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}
