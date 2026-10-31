import { describe, expect, it, vi, afterEach } from "vitest";
import { processQuoJob } from "../../supabase/functions/_shared/quo-worker";
import {
  createQuoCheckpoint,
  encryptQuoCheckpoint,
} from "../../supabase/functions/_shared/quo-sync";

const job = {
  runId: "run-1",
  leaseToken: "lease-1",
  leadId: "lead-1",
  checkpoint: null as string | null,
  inboxIds: Array.from({ length: 39 }, (_, i) => `PN${i}`),
  snapshot: "2026-10-21T12:00:00Z",
  failures: 0,
  customerNumber: "9105551234",
  customerNumber2: null,
  extraNumbers: [],
  assignedAt: "2026-10-20T12:00:00Z",
  service: "Painting",
};
function fakeDb(current: typeof job & { inboxMatched?: boolean }) {
  const rpc = vi.fn().mockImplementation(async (name: string) => ({
    data: name === "claim_quo_ai_job" ? current : true,
    error: null,
  }));
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { rpc, from: vi.fn().mockReturnValue(chain) };
}
afterEach(() => vi.unstubAllGlobals());
describe("bounded resumable Quo worker", () => {
  it("never publishes a partial 16/39-inbox result", async () => {
    {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(
            async () => new Response(JSON.stringify({ data: [], nextPageToken: null })),
          ),
      );
      const db = fakeDb({ ...job });
      const pending = processQuoJob(db as never, "test-secret", "model-secret", {
        wait: async () => {},
      });
      expect((await pending).processed).toBe(0);
      expect(db.rpc.mock.calls.some(([name]) => name === "finish_quo_ai_job")).toBe(false);
      const save = db.rpc.mock.calls.find(([name]) => name === "checkpoint_quo_ai_job")!;
      expect(save[1].p_done).toBe(16);
      expect(save[1].p_total).toBe(39);
      expect(save[1].p_checkpoint).toMatch(/^v1\./);
      expect(save[1].p_checkpoint).not.toContain("9105551234");
    }
  });
  it("finishes only after the last inbox and keeps unmatched history out of AI categories", async () => {
    const checkpoint = createQuoCheckpoint(job.snapshot, [job.customerNumber]);
    checkpoint.inboxIndex = 32;
    const encrypted = await encryptQuoCheckpoint(checkpoint, "test-secret", job.runId);
    {
      const fetcher = vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify({ data: [], nextPageToken: null })),
        );
      vi.stubGlobal("fetch", fetcher);
      const db = fakeDb({ ...job, checkpoint: encrypted });
      const pending = processQuoJob(db as never, "test-secret", "model-secret", {
        wait: async () => {},
      });
      expect((await pending).processed).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(7);
      const finish = db.rpc.mock.calls.find(([name]) => name === "finish_quo_ai_job")!;
      expect(finish[1].p_result.state).toBe("unmatched");
      expect(finish[1].p_result.status).toBeNull();
    }
  });
  it("skips the shared-phone guard when it reads the lead's own matched inbox", async () => {
    // A number shared with another lead on a DIFFERENT inbox must not park this
    // lead in review: reading one inbox is one unambiguous conversation.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify({ data: [], nextPageToken: null })),
        ),
    );
    const db = fakeDb({ ...job, inboxIds: ["PN0"], inboxMatched: true });
    const result = await processQuoJob(db as never, "test-secret", "model-secret", {
      wait: async () => {},
    });
    expect(result.processed).toBe(1);
    expect(db.rpc.mock.calls.some(([name]) => name === "lead_ai_phone_is_unique")).toBe(false);
    const finish = db.rpc.mock.calls.find(([name]) => name === "finish_quo_ai_job")!;
    expect(finish[1].p_result.reasonCode).not.toBe("phone_shared_between_leads");
  });
});
