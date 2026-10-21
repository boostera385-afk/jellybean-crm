export type AiStatusReport = {
  samples?: Array<{
    leadId: string;
    customerName: string | null;
    manualStatus: string;
    aiStatus: string | null;
    state: string;
    confidence: number | null;
    reasonCode: string;
    analyzedAt: string;
  }>;
  counts: Record<string, number>;
  total: number;
  classified: number;
  disagreements: number;
  review: number;
  stale: number;
  lastAnalyzedAt: string | null;
};

/** Do not turn a missing/error response into convincing zero AI counts. */
export function parseAiStatusReport(value: unknown): AiStatusReport {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid AI report");
  const v = value as Record<string, unknown>;
  const fields = ["total", "classified", "disagreements", "review", "stale"] as const;
  for (const field of fields)
    if (typeof v[field] !== "number" || !Number.isSafeInteger(v[field]) || v[field] < 0)
      throw new Error("Invalid AI report");
  if (!v.counts || typeof v.counts !== "object" || Array.isArray(v.counts))
    throw new Error("Invalid AI counts");
  for (const count of Object.values(v.counts))
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid AI counts");
  if (
    v.lastAnalyzedAt !== null &&
    (typeof v.lastAnalyzedAt !== "string" || !Number.isFinite(Date.parse(v.lastAnalyzedAt)))
  )
    throw new Error("Invalid AI timestamp");
  if (
    v.samples !== undefined &&
    (!Array.isArray(v.samples) ||
      v.samples.some(
        (sample) =>
          !sample ||
          typeof sample !== "object" ||
          typeof sample.leadId !== "string" ||
          typeof sample.manualStatus !== "string" ||
          typeof sample.reasonCode !== "string" ||
          !(sample.aiStatus === null || typeof sample.aiStatus === "string") ||
          !(sample.confidence === null || typeof sample.confidence === "number"),
      ))
  )
    throw new Error("Invalid AI samples");
  return v as AiStatusReport;
}
