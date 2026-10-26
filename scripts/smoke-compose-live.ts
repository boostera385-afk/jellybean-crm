/**
 * Run the REAL shared draft/review/guard pipeline, never an approximate replica.
 * bun run scripts/smoke-compose-live.ts <cases.json>
 *
 * Local: OPENAI_API_KEY + array of ComposerInput cases. Optional forbiddenKeys
 * per case gate a regression; labels are not learned from delivered messages.
 * Deployed: CS_TEST_USER_JWT + SUPABASE_URL + array of {leadId, forbiddenKeys?}.
 * This calls the JWT/role/RLS-protected Edge Function without extracting secrets.
 * No messages are sent and no marketing_notes are changed. Do NOT commit tokens
 * or input/output files containing customer information.
 */
import { readFileSync } from "node:fs";
import {
  composeAnswerAware,
  renderComposePlan,
  scoreComposeReply,
  CS_COMPOSER_VERSION,
  type ComposerEvalCase,
} from "../supabase/functions/_shared/cs-composer.ts";

type Case = ComposerEvalCase & {
  leadId?: string;
};
const file = process.argv[2];
if (!file) throw new Error("usage: bun run scripts/smoke-compose-live.ts <cases.json>");
const cases = JSON.parse(readFileSync(file, "utf8")) as Case[];
let failures = 0;
for (const [index, entry] of cases.entries()) {
  try {
    let output: { rephrased: string; version: string; warnings: string[]; questionKeys: string[] };
    if (entry.leadId) {
      const jwt = process.env.CS_TEST_USER_JWT;
      const url = process.env.SUPABASE_URL;
      if (!jwt || !url)
        throw new Error("Set CS_TEST_USER_JWT and SUPABASE_URL for deployed testing");
      const res = await fetch(`${url}/functions/v1/cs-compose-lead`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: entry.leadId }),
      });
      if (!res.ok) throw new Error(`Deployed composer returned ${res.status}`);
      output = await res.json();
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey)
        throw new Error(
          "Set OPENAI_API_KEY for local model testing, or use authenticated deployed leadId cases",
        );
      if (!entry.input) throw new Error("Local case requires input");
      const result = await composeAnswerAware(entry.input, { apiKey, fitQuestions: true });
      output = {
        rephrased: renderComposePlan(entry.input, result.plan, "Alex"),
        version: result.version,
        warnings: result.warnings,
        questionKeys: result.plan.questions.map((q) => q.key),
      };
    }
    const score = scoreComposeReply(entry, output.rephrased, output.questionKeys);
    const ok = output.version === CS_COMPOSER_VERSION && score.pass;
    if (!ok) failures++;
    console.log(JSON.stringify({ case: index + 1, ...output, ...score, pass: ok }));
  } catch (error) {
    failures++;
    console.error(
      JSON.stringify({ case: index + 1, error: (error as Error).message, pass: false }),
    );
  }
}
console.log(
  `${cases.length - failures}/${cases.length} cases passed version/forbidden-intent gates; human relevance review still required.`,
);
process.exitCode = failures ? 1 : 0;
