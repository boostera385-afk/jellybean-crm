import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ImagePlus,
  Loader2,
  Star,
  Upload,
  X,
  Plus,
  AlertTriangle,
  Video,
  ExternalLink,
  PhoneOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { formatPhone, normalizePhone } from "@/lib/crm-lite";
import { FACEBOOK_LEAD_REFERENCE, formatPhoneInput } from "@/lib/lead-form-utils";
import { checkDuplicatePhone } from "@/lib/raw-leads.functions";
import {
  compressVideoInBrowser,
  MAX_VIDEO_BYTES,
  ALLOWED_VIDEO_MIME_TYPES,
  getVideoDimensions,
} from "@/lib/video-compressor";
import {
  DuplicateLeadDialog,
  type DuplicateMatchPreview,
} from "@/components/duplicate-lead-dialog";
import { useSignedLeadUrls } from "@/lib/lead-attachments";
import { ServiceCombobox } from "@/components/service-combobox";
import { StateCombobox } from "@/components/state-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { extractUsStateCodeFromArea } from "@/lib/us-states";
const MAX_IMAGES = 20;
const MAX_BYTES = 10 * 1024 * 1024;

export type LeadReferenceMode = "manual-dropdown" | "auto-scraping" | "auto-fb" | "manual-text";

type DupMatch = {
  id: string;
  customer_name: string;
  customer_number: string;
  customer_number_2: string | null;
  assigned_at: string;
  main_area: string | null;
  sub_area: string | null;
  service: string | null;
  context: string | null;
  original_lead_link: string | null;
};

export type LeadFormValues = {
  customerName: string;
  customerNumber: string;
  area: string;
  stateCode: string;
  service: string;
  context: string;
  exactCustomerText: string;
  reference: string;
  isImportant: boolean;
  isLandline: boolean;
  files: File[];
  existingImages?: string[];
  extraNumbers?: string[];
  originalLeadLink?: string | null;
};

type LeadFormInitialValues = {
  customerName?: string;
  customerNumber?: string;
  area?: string;
  stateCode?: string;
  service?: string;
  context?: string;
  exactCustomerText?: string;
  reference?: string;
  isImportant?: boolean;
  isLandline?: boolean;
  extraNumbers?: string[];
  images?: string[];
  id?: string;
  originalLeadLink?: string | null;
};

export function LeadForm({
  title = "Lead form",
  submitLabel = "Save",
  forwardedBy,
  showAttachments,
  areaRequired,
  showState = false,
  stateRequired = false,
  referenceMode,
  initialValues,
  submitting,
  onDirtyChange,
  onCancel,
  onSubmit,
  onSaveDraft,
  onNumberNotFound,
  disableDuplicateCheck = false,
}: {
  title?: string;
  submitLabel?: string;
  forwardedBy: string;
  showAttachments: boolean;
  areaRequired: boolean;
  showState?: boolean;
  stateRequired?: boolean;
  referenceMode: LeadReferenceMode;
  initialValues?: LeadFormInitialValues;
  submitting?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onCancel: () => void;
  onSubmit: (values: LeadFormValues) => Promise<void>;
  onSaveDraft?: (values: LeadFormValues) => Promise<void>;
  onNumberNotFound?: () => Promise<void> | void;
  disableDuplicateCheck?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoFileRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const toastIdRef = useRef<string | number | null>(null);

  const [customerName, setCustomerName] = useState(initialValues?.customerName ?? "");
  const [customerNumber, setCustomerNumber] = useState(initialValues?.customerNumber ?? "");
  const [extraNumbers, setExtraNumbers] = useState<string[]>(initialValues?.extraNumbers ?? []);
  const [area, setArea] = useState(initialValues?.area ?? "");
  const [stateCode, setStateCode] = useState(initialValues?.stateCode ?? "");
  const [service, setService] = useState(initialValues?.service ?? "");
  const [context, setContext] = useState(initialValues?.context ?? "");
  const [exactCustomerText, setExactCustomerText] = useState(
    initialValues?.exactCustomerText ?? "",
  );
  const [reference, setReference] = useState(
    resolveInitialReference(referenceMode, initialValues?.reference),
  );
  const [importantValue, setImportantValue] = useState(
    (initialValues?.isImportant ?? false) ? "yes" : "no",
  );
  const [isLandline, setIsLandline] = useState<boolean>(initialValues?.isLandline ?? false);
  const [existingImages, setExistingImages] = useState<string[]>(initialValues?.images ?? []);
  const existingImageUrls = useSignedLeadUrls(existingImages);
  const [files, setFiles] = useState<File[]>([]);
  const originalLeadLink = initialValues?.originalLeadLink ?? null;
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressionProgress, setCompressionProgress] = useState(0);
  // Duplicate check race condition fix
  const [isCheckingBeforeSubmit, setIsCheckingBeforeSubmit] = useState(false);
  const [showDupConfirm, setShowDupConfirm] = useState(false);
  const [dupConfirmMatches, setDupConfirmMatches] = useState<DuplicateMatchPreview[]>([]);
  // Holds the resolved form values waiting for user to confirm or cancel
  const pendingSubmitValuesRef = useRef<LeadFormValues | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [markingNotFound, setMarkingNotFound] = useState(false);
  const autoDetectedStateRef = useRef<string | null>(null);

  function handleAreaChange(nextArea: string) {
    setArea(nextArea);
    if (!showState) return;

    const detectedState = extractUsStateCodeFromArea(nextArea);
    if (detectedState) {
      autoDetectedStateRef.current = detectedState;
      setStateCode(detectedState);
    } else if (autoDetectedStateRef.current === stateCode) {
      autoDetectedStateRef.current = null;
      setStateCode("");
    }
  }

  function handleStateChange(nextStateCode: string) {
    autoDetectedStateRef.current = null;
    setStateCode(nextStateCode);
  }

  // Baseline snapshot representing the last "clean" state (initial values, or
  // the values that were just persisted via Save Draft). isDirty compares
  // against this baseline so that saving a draft clears the unsaved-changes
  // warning without weakening it for genuine edits made afterwards.
  type FormBaseline = {
    customerName: string;
    customerNumber: string;
    area: string;
    stateCode: string;
    service: string;
    context: string;
    exactCustomerText: string;
    reference: string;
    importantValue: string;
    isLandline: boolean;
    extraNumbers: string[];
    existingImagesLen: number;
    filesLen: number;
  };
  const buildInitialBaseline = (): FormBaseline => ({
    customerName: initialValues?.customerName ?? "",
    customerNumber: initialValues?.customerNumber ?? "",
    area: initialValues?.area ?? "",
    stateCode: initialValues?.stateCode ?? "",
    service: initialValues?.service ?? "",
    context: initialValues?.context ?? "",
    exactCustomerText: initialValues?.exactCustomerText ?? "",
    reference: resolveInitialReference(referenceMode, initialValues?.reference),
    importantValue: (initialValues?.isImportant ?? false) ? "yes" : "no",
    isLandline: initialValues?.isLandline ?? false,
    extraNumbers: initialValues?.extraNumbers ?? [],
    existingImagesLen: initialValues?.images?.length ?? 0,
    filesLen: 0,
  });
  const [baseline, setBaseline] = useState<FormBaseline>(() => buildInitialBaseline());

  useEffect(() => {
    return () => {
      // Cleanup on unmount (if dialog closes)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (toastIdRef.current) {
        toast.dismiss(toastIdRef.current);
      }
    };
  }, []);

  const checkDuplicate = useServerFn(checkDuplicatePhone);
  const phoneDigits = useMemo(
    () =>
      [customerNumber, ...extraNumbers]
        .map((p) => normalizePhone(p ?? ""))
        .filter((d) => d.length >= 7),
    [customerNumber, extraNumbers],
  );
  // Debounce phone digits so the duplicate-check RPC does not fire on every
  // keystroke while the user is still typing.
  const [debouncedPhoneDigits, setDebouncedPhoneDigits] = useState<string[]>(phoneDigits);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPhoneDigits(phoneDigits), 400);
    return () => clearTimeout(t);
  }, [phoneDigits]);
  const duplicateQuery = useQuery({
    queryKey: ["lead-form-duplicate-phone", debouncedPhoneDigits.join(",")],
    enabled: !disableDuplicateCheck && debouncedPhoneDigits.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        debouncedPhoneDigits.map((digits) => checkDuplicate({ data: { phone: digits } })),
      );
      return results.flatMap((r) => (r.matches ?? []) as DupMatch[]);
    },
    staleTime: 60_000,
  });
  const seenDup = new Set<string>();
  if (initialValues?.id) {
    seenDup.add(initialValues.id);
  }
  const uniqueDuplicates = disableDuplicateCheck
    ? []
    : (duplicateQuery.data ?? []).filter((m) => {
        if (seenDup.has(m.id)) return false;
        seenDup.add(m.id);
        return true;
      });
  const hasDuplicate = uniqueDuplicates.length > 0;

  // True while the background query is still loading OR we are doing the
  // final gate-check inside handleSubmit. The submit button must be disabled
  // during this entire window to prevent the race condition.
  const isDuplicateCheckPending =
    !disableDuplicateCheck &&
    phoneDigits.length > 0 &&
    (duplicateQuery.isLoading ||
      duplicateQuery.isFetching ||
      duplicateQuery.isRefetching ||
      isCheckingBeforeSubmit);

  const isDirty =
    customerName !== baseline.customerName ||
    customerNumber !== baseline.customerNumber ||
    area !== baseline.area ||
    stateCode !== baseline.stateCode ||
    service !== baseline.service ||
    context !== baseline.context ||
    exactCustomerText !== baseline.exactCustomerText ||
    reference !== baseline.reference ||
    importantValue !== baseline.importantValue ||
    isLandline !== baseline.isLandline ||
    files.length !== baseline.filesLen ||
    existingImages.length !== baseline.existingImagesLen ||
    JSON.stringify(extraNumbers) !== JSON.stringify(baseline.extraNumbers);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  function addFiles(picked: FileList | null) {
    if (!picked) return;
    const incoming = Array.from(picked);
    const valid: File[] = [];
    for (const file of incoming) {
      if (!file.type.startsWith("image/")) {
        toast.error(`${file.name} is not an image`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is larger than 10 MB`);
        continue;
      }
      valid.push(file);
    }
    setFiles((prev) => {
      const merged = [...prev, ...valid];
      const allowedCount = MAX_IMAGES - (existingImages.length + prev.length);
      if (merged.length > allowedCount) {
        toast.error(`Maximum ${MAX_IMAGES} attachments limit reached`);
        return merged.slice(0, allowedCount);
      }
      return merged;
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  async function addVideoFile(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const file = picked[0];

    if (!ALLOWED_VIDEO_MIME_TYPES.includes(file.type)) {
      toast.error(`Invalid video format. Allowed: mp4, webm, mov.`);
      if (videoFileRef.current) videoFileRef.current.value = "";
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      toast.error(`Video is larger than 50 MB.`);
      if (videoFileRef.current) videoFileRef.current.value = "";
      return;
    }

    if (files.length >= MAX_IMAGES) {
      toast.error(`Maximum 20 attachments total.`);
      if (videoFileRef.current) videoFileRef.current.value = "";
      return;
    }

    // Smart skip compression for small videos (<= 10MB)
    if (file.size <= 10 * 1024 * 1024) {
      try {
        const { height } = await getVideoDimensions(file);
        if (height <= 720) {
          setFiles((prev) => [...prev, file]);
          toast.success("Video added!");
          if (videoFileRef.current) videoFileRef.current.value = "";
          return;
        }
      } catch (err) {
        console.warn("Failed to get video dimensions, falling back to compression", err);
      }
    }

    // Dismiss any lingering previous success toast before starting a new job
    if (toastIdRef.current) {
      toast.dismiss(toastIdRef.current);
      toastIdRef.current = null;
    }

    setIsCompressing(true);
    setCompressionProgress(0);

    // Abort any previous in-flight compression
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {
        // Ignored
      }
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Stable job id — used to guard against stale async resolutions
    const jobId = Symbol("compression-job");
    const state = { cancelled: false, canceling: false };

    const toastId = toast.loading("Compressing video...", { duration: Infinity });
    toastIdRef.current = toastId;

    const isActive = () =>
      !state.cancelled && !controller.signal.aborted && abortControllerRef.current === controller;

    const cancelJob = () => {
      if (state.cancelled) return;
      state.cancelled = true;
      state.canceling = true;
      try {
        controller.abort();
      } catch (e) {
        console.error("Abort error:", e);
      }
      renderToast(0);
      setTimeout(() => toast.dismiss(toastId), 200);
      // Reset input immediately so the same file can be reselected
      if (videoFileRef.current) videoFileRef.current.value = "";
      setIsCompressing(false);
      setCompressionProgress(0);
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (toastIdRef.current === toastId) {
        toastIdRef.current = null;
      }
    };

    const renderToast = (progress: number) => {
      toast.loading(
        <div className="relative flex items-center w-[300px] pr-9">
          <span className="flex-1 min-w-0 truncate">
            {state.canceling
              ? "Canceling..."
              : progress > 0
                ? `Compressing video (${progress}%)...`
                : "Compressing video..."}
          </span>
          <button
            type="button"
            aria-label="Cancel video compression"
            disabled={state.canceling}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              cancelJob();
            }}
            style={{ pointerEvents: "auto" }}
            className="absolute right-0 top-1/2 -translate-y-1/2 shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/80 text-foreground opacity-100 shadow-sm transition hover:bg-destructive hover:text-destructive-foreground hover:border-destructive focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>,
        { id: toastId, duration: Infinity, dismissible: false },
      );
    };

    renderToast(0);

    try {
      const compressedFile = await compressVideoInBrowser(
        file,
        (progress) => {
          if (!isActive()) return;
          setCompressionProgress(progress);
          renderToast(progress);
        },
        controller.signal,
      );

      if (!isActive()) {
        throw new Error("AbortError");
      }

      setFiles((prev) => [...prev, compressedFile]);
      toast.success("Video compressed and added!", { id: toastId, duration: 3500 });
      // Toast now owns its own auto-dismiss; drop our ref so future jobs don't dismiss it early via cleanup
      toastIdRef.current = null;
    } catch (err) {
      if (state.cancelled || (err instanceof Error && err.message === "AbortError")) {
        toast.dismiss(toastId);
        return;
      }
      console.error("Video compression error:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      toast.error(`Compression failed: ${errorMessage}`, { id: toastId, duration: 5000 });
      toastIdRef.current = null;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      // Only reset compression UI state if this job is still the active one
      if (jobId && !state.cancelled) {
        setIsCompressing(false);
        setCompressionProgress(0);
      }
      if (videoFileRef.current) videoFileRef.current.value = "";
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== index));
  }

  function handlePaste(event: React.ClipboardEvent) {
    if (!showAttachments) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    event.preventDefault();
    const dt = new DataTransfer();
    imageFiles.forEach((file) => dt.items.add(file));
    addFiles(dt.files);
    toast.success(`Pasted ${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"}`);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!customerName.trim() || !customerNumber.trim()) {
      toast.error("Customer name and customer number are required");
      return;
    }
    if (areaRequired && !area.trim()) {
      toast.error("Area is required");
      return;
    }
    if (stateRequired && !stateCode.trim()) {
      toast.error("State is required");
      return;
    }
    if (!service.trim()) {
      toast.error("Service is required");
      return;
    }
    if (!context.trim()) {
      toast.error("Context is required");
      return;
    }
    if (!exactCustomerText.trim()) {
      toast.error("Exact customer text is required");
      return;
    }
    if (!reference.trim()) {
      toast.error("Reference is required");
      return;
    }

    // Build the payload now so we can reuse it after confirmation
    const payload: LeadFormValues = {
      customerName: customerName.trim(),
      customerNumber: customerNumber.trim(),
      area: area.trim(),
      stateCode: stateCode.trim(),
      service: service.trim(),
      context: context.trim(),
      exactCustomerText: exactCustomerText.trim(),
      reference: reference.trim(),
      isImportant: importantValue === "yes",
      isLandline,
      files,
      existingImages,
      extraNumbers: extraNumbers.filter((num) => num.trim() !== ""),
      originalLeadLink: originalLeadLink,
    };

    if (!disableDuplicateCheck && phoneDigits.length > 0) {
      // --- RACE-CONDITION FIX ---
      // Always run a fresh check with the *current* phone digits so we are
      // never relying on stale React Query cache that may not have resolved yet.
      setIsCheckingBeforeSubmit(true);
      let freshMatches: DupMatch[] = [];
      try {
        const results = await Promise.all(
          phoneDigits.map((digits) => checkDuplicate({ data: { phone: digits } })),
        );
        const allMatches = results.flatMap((r) => (r.matches ?? []) as DupMatch[]);
        // Exclude the lead being edited (if any) so it doesn't flag itself
        const excludeId = initialValues?.id;
        const seen = new Set<string>(excludeId ? [excludeId] : []);
        freshMatches = allMatches.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      } catch {
        // If the duplicate check itself fails (network error, etc.) we still
        // allow submission rather than silently blocking the user.
        freshMatches = [];
      } finally {
        setIsCheckingBeforeSubmit(false);
      }

      if (freshMatches.length > 0) {
        // Map matches to the preview format required by DuplicateLeadDialog
        // Map matches to the preview format required by DuplicateLeadDialog
        const secondTargetNumbers = extraNumbers
          .map((n) => normalizePhone(n))
          .filter((n) => n.length >= 7);

        const previewMatches: DuplicateMatchPreview[] = freshMatches.map((match) => {
          let sourceLabel = "Primary number";
          if (
            secondTargetNumbers.length > 0 &&
            (secondTargetNumbers.includes(normalizePhone(match.customer_number)) ||
              (match.customer_number_2 &&
                secondTargetNumbers.includes(normalizePhone(match.customer_number_2))))
          ) {
            sourceLabel = "Additional number";
          }
          return {
            source: sourceLabel,
            match,
          };
        });

        // Show confirmation dialog – user can Cancel or Continue Anyway
        pendingSubmitValuesRef.current = payload;
        setDupConfirmMatches(previewMatches);
        setShowDupConfirm(true);
        return; // Stop here; submission continues only if user confirms
      }
    }

    await onSubmit(payload);
  }

  // Called when the user clicks "Continue Anyway" in the duplicate dialog
  async function continueDespiteDuplicate() {
    setShowDupConfirm(false);
    const payload = pendingSubmitValuesRef.current;
    pendingSubmitValuesRef.current = null;
    if (!payload) return;
    await onSubmit(payload);
  }

  // Save Draft: capture current values WITHOUT running required-field
  // validation or duplicate checks. onSaveDraft owns persistence.
  async function handleSaveDraft() {
    if (!onSaveDraft) return;
    const payload: LeadFormValues = {
      customerName: customerName.trim(),
      customerNumber: customerNumber.trim(),
      area: area.trim(),
      stateCode: stateCode.trim(),
      service: service.trim(),
      context: context.trim(),
      exactCustomerText: exactCustomerText.trim(),
      reference: reference.trim(),
      isImportant: importantValue === "yes",
      isLandline,
      files,
      existingImages,
      extraNumbers: (extraNumbers ?? []).filter((n) => n.trim() !== ""),
      originalLeadLink,
    };
    setSavingDraft(true);
    try {
      await onSaveDraft(payload);
      // Draft persisted successfully — snapshot the current form state as the
      // new clean baseline so closing the modal doesn't warn about "unsaved"
      // changes that were, in fact, just saved.
      setBaseline({
        customerName: payload.customerName,
        customerNumber: payload.customerNumber,
        area: payload.area,
        stateCode: payload.stateCode,
        service: payload.service,
        context: payload.context,
        exactCustomerText: payload.exactCustomerText,
        reference: payload.reference,
        importantValue: payload.isImportant ? "yes" : "no",
        isLandline: payload.isLandline,
        extraNumbers: payload.extraNumbers ?? [],
        existingImagesLen: existingImages.length,
        filesLen: files.length,
      });
    } finally {
      setSavingDraft(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} onPaste={handlePaste} className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-[12px] text-muted-foreground">
          This unified form is now used for lead submission and forwarding.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Customer Name" required>
          <Input
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            maxLength={120}
          />
        </Field>
        <Field label="Customer Number" required>
          <Input
            value={customerNumber}
            onChange={(e) => setCustomerNumber(formatPhoneInput(e.target.value))}
            maxLength={40}
            inputMode="tel"
          />
        </Field>
        <Field label="Area" required={areaRequired}>
          <Input
            value={area}
            onChange={(e) => handleAreaChange(e.target.value)}
            maxLength={160}
            placeholder={
              areaRequired ? "City or neighborhood, state (e.g. Austin, TX)" : "Optional area"
            }
          />
        </Field>
        {showState && (
          <Field label="State" required={stateRequired} htmlFor="lead-state">
            <StateCombobox
              id="lead-state"
              value={stateCode}
              onChange={handleStateChange}
              required={stateRequired}
            />
          </Field>
        )}
        <Field label="Service" required htmlFor="lead-service">
          <ServiceCombobox
            id="lead-service"
            value={service}
            onChange={setService}
            required
            maxLength={120}
          />
        </Field>
      </div>

      <div className="space-y-2.5">
        <Label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Additional Numbers (Optional, Max 5)
        </Label>
        {extraNumbers.map((num, index) => (
          <div key={index} className="flex gap-2 items-center">
            <Input
              value={num}
              onChange={(e) => {
                const val = e.target.value;
                setExtraNumbers((prev) =>
                  prev.map((n, i) => (i === index ? formatPhoneInput(val) : n)),
                );
              }}
              maxLength={40}
              placeholder={`Additional number ${index + 1}`}
              inputMode="tel"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                setExtraNumbers((prev) => prev.filter((_, i) => i !== index));
              }}
              aria-label="Remove additional number"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {extraNumbers.length < 5 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setExtraNumbers((prev) => [...prev, ""])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add another number
          </Button>
        )}
      </div>

      {originalLeadLink && (
        <div className="min-w-0">
          <Label className="block mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Original Post Link
          </Label>
          <a
            href={originalLeadLink}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-primary hover:underline text-sm font-medium truncate max-w-full"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            View Post
          </a>
        </div>
      )}

      <Field label="Context" required>
        <Textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={3}
          maxLength={2000}
        />
      </Field>

      <Field label="Exact Customer Text" required>
        <Textarea
          value={exactCustomerText}
          onChange={(e) => setExactCustomerText(e.target.value)}
          rows={4}
          maxLength={4000}
        />
      </Field>

      <Field label="Reference" required>
        {referenceMode === "manual-dropdown" ? (
          <select
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="ND">ND</option>
            <option value="Had a conversation on Nextdoor">Had a conversation on Nextdoor</option>
          </select>
        ) : referenceMode === "manual-text" ? (
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={160} />
        ) : (
          <Input value={reference} readOnly className="bg-muted/50" />
        )}
      </Field>

      <Field label="Forwarded By (Auto)">
        <Input value={forwardedBy} readOnly className="bg-muted/50" />
      </Field>

      <Field label="Mark as important" required>
        <RadioGroup value={importantValue} onValueChange={setImportantValue} className="grid gap-2">
          <label className="flex items-center gap-2 rounded-md border border-border bg-surface/60 px-3 py-2 cursor-pointer">
            <RadioGroupItem value="yes" id="important-yes" />
            <Star
              className={cn(
                "h-3.5 w-3.5",
                importantValue === "yes" ? "fill-warning text-warning" : "text-muted-foreground",
              )}
            />
            <span className="text-sm">Yes, mark as important</span>
          </label>
          <label className="flex items-center gap-2 rounded-md border border-border bg-surface/60 px-3 py-2 cursor-pointer">
            <RadioGroupItem value="no" id="important-no" />
            <span className="text-sm">No</span>
          </label>
        </RadioGroup>
      </Field>

      <Field label="">
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-white/30 bg-transparent accent-primary"
            checked={isLandline}
            onChange={(e) => setIsLandline(e.target.checked)}
          />
          <span className="text-sm">Landline</span>
        </label>
      </Field>

      {showAttachments ? (
        <Field label="Add Attachment">
          <div className="space-y-3">
            <div className="text-[11px] text-muted-foreground flex gap-4">
              <span>Images: Up to 20 total, 10MB each.</span>
              <span>Videos: Up to 50MB (auto-compressed to 720p).</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <input
              ref={videoFileRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              className="hidden"
              onChange={(e) => {
                void addVideoFile(e.target.files);
              }}
            />
            <div className="flex flex-wrap gap-3 items-start">
              {/* Existing Images from DB */}
              {existingImages.map((ref, idx) => {
                const url = existingImageUrls[idx] ?? ref;
                const isVideo = /\.(mp4|webm|mov)(\?.*)?$/i.test(ref);
                return (
                  <div
                    key={`existing-${idx}`}
                    className={cn(
                      "relative rounded-md overflow-hidden border border-border bg-muted",
                      isVideo ? "h-32 w-48" : "h-20 w-20",
                    )}
                  >
                    {isVideo ? (
                      <video
                        src={url}
                        className="h-full w-full object-cover"
                        controls
                        controlsList="nodownload"
                        preload="metadata"
                      />
                    ) : (
                      <img src={url} alt="" className="h-full w-full object-cover" />
                    )}
                    <button
                      type="button"
                      onClick={() => setExistingImages((prev) => prev.filter((_, i) => i !== idx))}
                      className="absolute top-0.5 right-0.5 h-5 w-5 grid place-items-center rounded-full bg-background/90 hover:bg-destructive hover:text-destructive-foreground transition-colors z-10"
                      aria-label="Remove existing image"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}

              {/* Newly added files */}
              {files.map((file, index) => {
                const isVideo = file.type.startsWith("video/");
                return (
                  <div
                    key={`${file.name}-${index}`}
                    className={cn(
                      "relative rounded-md overflow-hidden border border-border bg-muted",
                      isVideo ? "h-32 w-48" : "h-20 w-20",
                    )}
                  >
                    {isVideo ? (
                      <video
                        src={URL.createObjectURL(file)}
                        className="h-full w-full object-cover"
                        controls
                        controlsList="nodownload"
                        preload="metadata"
                      />
                    ) : (
                      <img
                        src={URL.createObjectURL(file)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="absolute top-0.5 right-0.5 h-5 w-5 grid place-items-center rounded-full bg-background/90 hover:bg-destructive hover:text-destructive-foreground transition-colors z-10"
                      aria-label="Remove file"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              {files.length + existingImages.length < MAX_IMAGES && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={isCompressing || submitting}
                    className="h-20 w-20 rounded-md border-2 border-dashed border-border hover:border-primary hover:bg-primary/5 transition-colors grid place-items-center text-muted-foreground hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex flex-col items-center gap-1 text-[11px]">
                      <ImagePlus className="h-4 w-4" />
                      Image
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => videoFileRef.current?.click()}
                    disabled={isCompressing || submitting}
                    className="h-20 w-20 rounded-md border-2 border-dashed border-border hover:border-primary hover:bg-primary/5 transition-colors grid place-items-center text-muted-foreground hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex flex-col items-center gap-1 text-[11px]">
                      {isCompressing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {compressionProgress}%
                        </>
                      ) : (
                        <>
                          <Video className="h-4 w-4" />
                          Video
                        </>
                      )}
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </Field>
      ) : null}

      {hasDuplicate ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[12.5px]">
          <div className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Duplicate phone number detected (last 48 hours)
          </div>
          <ul className="mt-2 space-y-1 text-foreground/80">
            {uniqueDuplicates.slice(0, 5).map((m) => (
              <li key={m.id}>
                {m.customer_name} — {formatPhone(m.customer_number)}
                {m.customer_number_2 ? ` / ${formatPhone(m.customer_number_2)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-2 pt-2 border-t border-border sm:flex-row sm:items-center sm:justify-between">
        <div>
          {onNumberNotFound ? (
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                setMarkingNotFound(true);
                try {
                  await onNumberNotFound();
                } finally {
                  setMarkingNotFound(false);
                }
              }}
              disabled={submitting || savingDraft || isCompressing || markingNotFound}
            >
              {markingNotFound ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <PhoneOff className="h-4 w-4 mr-2" />
              )}
              Number not found
            </Button>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (
                isDirty &&
                !window.confirm("You have unsaved changes. Are you sure you want to close?")
              )
                return;
              if (abortControllerRef.current) abortControllerRef.current.abort();
              if (toastIdRef.current) toast.dismiss(toastIdRef.current);
              setIsCompressing(false);
              setCompressionProgress(0);
              onCancel();
            }}
            disabled={submitting || savingDraft}
          >
            Cancel
          </Button>
          {onSaveDraft ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleSaveDraft()}
              disabled={submitting || savingDraft || isCompressing}
            >
              {savingDraft ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Saving draft...
                </>
              ) : (
                "Draft"
              )}
            </Button>
          ) : null}
          <Button
            type="submit"
            disabled={submitting || savingDraft || isCompressing || isDuplicateCheckPending}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Saving...
              </>
            ) : isDuplicateCheckPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Checking duplicate...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                {submitLabel}
              </>
            )}
          </Button>
        </div>
      </div>

      <DuplicateLeadDialog
        open={showDupConfirm}
        onOpenChange={setShowDupConfirm}
        matches={dupConfirmMatches}
        isConfirming={submitting}
        onCancel={() => {
          setShowDupConfirm(false);
          pendingSubmitValuesRef.current = null;
        }}
        onConfirm={() => void continueDespiteDuplicate()}
      />
    </form>
  );
}

function resolveInitialReference(mode: LeadReferenceMode, provided?: string) {
  if (mode === "auto-fb") return FACEBOOK_LEAD_REFERENCE;
  if (provided?.trim()) return provided;
  if (mode === "manual-dropdown") return "ND";
  if (mode === "auto-scraping") return "ND";
  return "";
}

function Field({
  label,
  required = false,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <Label htmlFor={htmlFor} className="block mb-1.5">
        {label}
        {required ? <span className="text-destructive"> (Required)</span> : null}
      </Label>
      {children}
    </div>
  );
}
