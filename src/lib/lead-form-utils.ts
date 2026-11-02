import { normalizePhone } from "@/lib/crm-lite";

const BUCKET = "lead-attachments";

export const FACEBOOK_LEAD_REFERENCE = "Had a conversation on FB";

/** Progressive phone mask for the lead entry fields. */
export function formatPhoneInput(value: string): string {
  const digits = normalizePhone(value);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

/**
 * Upload lead attachments to Supabase Storage and return their storage paths.
 * The bucket is private, so callers render via signed URLs.
 */
export function uploadLeadImages({
  files,
  userId,
  supabase,
}: {
  files: File[];
  userId: string;
  supabase: {
    storage: {
      from: (bucket: string) => {
        upload: (
          path: string,
          file: File,
          options: { cacheControl: string; upsert: boolean; contentType: string },
        ) => Promise<{ error: { message: string } | null }>;
      };
    };
  };
}) {
  return Promise.all(
    files.map(async (file) => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type,
      });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      // Store the storage path (bucket is private; render via signed URLs).
      return path;
    }),
  );
}
