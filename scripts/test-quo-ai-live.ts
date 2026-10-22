// Optional live model smoke test using synthetic text only. No DB/Quo reads.
// Run: bun scripts/test-quo-ai-live.ts (OPENAI_API_KEY required; small API cost).
import {
  classifyQuoHistory,
  AI_STATUS_MODEL,
  type QuoMessage,
} from "../supabase/functions/_shared/quo-ai-status";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY required for optional live smoke test");
const cases = [
  {
    text: "No thanks, I am not interested. Please stop texting me.",
    expected: "cx_not_interested",
  },
  {
    text: "I already hired another painting company. The work is taken care of.",
    expected: "already_got_someone",
  },
];
for (const test of cases) {
  const messages: QuoMessage[] = [
    {
      id: "ACsynthetic1",
      text: test.text,
      direction: "incoming",
      status: "received",
      createdAt: "2026-10-20T12:00:00Z",
      updatedAt: "2026-10-20T12:00:00Z",
      conversationId: "CNsynthetic",
      phoneNumberId: "PNsynthetic",
      from: "+12025550101",
      to: ["+12025550102"],
    },
  ];
  const result = await classifyQuoHistory({
    messages,
    assignedAt: "2026-10-20T10:00:00Z",
    service: "Painting",
    apiKey,
    signal: AbortSignal.timeout(30_000),
  });
  if (result.status !== test.expected)
    throw new Error(
      `Synthetic classification failed: expected ${test.expected}, got ${result.status} (${result.reasonCode})`,
    );
  console.log(`PASS ${test.expected} (${AI_STATUS_MODEL})`);
}
