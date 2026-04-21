// =============================================================================
// Tests for src/lib/reconciler-rules/coherence-escalation.ts (factory-core-zsjv.4)
// =============================================================================

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { Reconciler } from "@/lib/reconciler";
import { appendEvent } from "@/lib/event-log";
import {
  buildCoherenceEscalationRule,
  type EpicSnapshot,
} from "@/lib/reconciler-rules/coherence-escalation";

async function makeRepo(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "zsjv4-test-"));
}

function snap(partial: Partial<EpicSnapshot>): EpicSnapshot {
  return {
    hasNeedsHuman: true,
    labels: ["pipeline:qa", "review:needs-human"],
    title: "test-epic",
    ...partial,
  };
}

async function seedEvent(repo: string, epicId: string): Promise<void> {
  await appendEvent(repo, {
    type: "agent-exited",
    epicId,
    payload: { exitCode: 0 },
  });
}

describe("coherence-escalation rule", () => {
  let fetchMock: jest.SpyInstance;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
        const body =
          init?.body && typeof init.body === "string"
            ? JSON.parse(init.body)
            : undefined;
        fetchCalls.push({ url: String(url), body });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  test("review:needs-human present + no prior dispatch → run-coherence-agent", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ hasNeedsHuman: true }),
      }),
    );
    await rec.tick();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      action: "run-coherence-agent",
      epicId: "factory-core-e1",
      anomalyClass: "review-needs-human",
    });
  });

  test("no review:needs-human → does not fire", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ hasNeedsHuman: false }),
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("prior run-coherence-agent dispatch in log → does not re-fire", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    // Synthesize a prior coherence dispatch event
    await appendEvent(repo, {
      type: "stage-dispatched",
      epicId: "factory-core-e1",
      correlationId: "some-earlier-tmux",
      payload: { toAction: "run-coherence-agent" },
    });

    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ hasNeedsHuman: true }),
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("null snapshot (bd failure) skips cleanly", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => null,
      }),
    );
    await rec.tick();
    expect(fetchCalls).toHaveLength(0);
  });

  test("idempotency: same tick bucket does not re-fire", async () => {
    const repo = await makeRepo();
    await seedEvent(repo, "factory-core-e1");
    const rec = new Reconciler({ repoPath: repo });
    rec.registerRule(
      buildCoherenceEscalationRule({
        readEpicSnapshot: async () => snap({ hasNeedsHuman: true }),
      }),
    );
    await rec.tick();
    await rec.tick();
    expect(fetchCalls).toHaveLength(1);
  });
});
