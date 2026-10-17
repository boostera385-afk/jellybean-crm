/** The editor controls optional style only. Safety policy is versioned in code. */
export const DEFAULT_REPHRASE_PROMPT = "";
export { CS_COMPOSER_VERSION } from "../../supabase/functions/_shared/cs-composer";

export function isCustomRephrasePrompt(prompt: string | null | undefined): boolean {
  return Boolean(prompt?.trim());
}
