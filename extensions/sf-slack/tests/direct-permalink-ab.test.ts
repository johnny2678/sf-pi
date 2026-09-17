/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Behavior Proof for direct Slack permalink reads.
 *
 * The A/B comparison exercises the same DM message through the public `slack`
 * tool seam:
 *   A — legacy channel + ts normalization, which must resolve an unverified ID
 *       and therefore opens the existing HITL selection dialog.
 *   B — a strict direct message_url locator, which should let the requested
 *       conversations.replies read validate access without resolver preflights.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelCache, getUserCache, setDetectedTeamId } from "../lib/api.ts";
import { registerSlackTool } from "../lib/tools.ts";

const CHANNEL_ID = "D01ABCDEF23";
const MESSAGE_TS = "1700000000.100001";
const MESSAGE_URL =
  "https://example.slack.com/archives/D01ABCDEF23/p1700000000100001?thread_ts=1700000000.100001&cid=D01ABCDEF23";

interface CapturedTool {
  name: string;
  execute?: (...args: never[]) => Promise<unknown>;
}

interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  details?: {
    ok?: boolean;
    action?: string;
    channel?: string;
    ts?: string;
    locator?: string;
    count?: number;
    reason?: string;
  };
}

interface ScenarioMetrics {
  result: ToolResult;
  endpointCalls: string[];
  requestBodies: Array<{ endpoint: string; body: string }>;
  selectCalls: number;
  inputCalls: number;
}

function captureSlackTool(): CapturedTool {
  const captured: CapturedTool[] = [];
  registerSlackTool({
    registerTool(definition: CapturedTool) {
      captured.push(definition);
    },
  } as never);

  const tool = captured.find((entry) => entry.name === "slack");
  if (!tool?.execute) throw new Error("slack tool did not register an execute handler");
  return tool;
}

function endpointFrom(input: string | URL | Request): string {
  return new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname
    .split("/")
    .filter(Boolean)
    .at(-1)!;
}

async function runScenario(
  params: Record<string, unknown>,
  options: { repliesError?: string } = {},
): Promise<ScenarioMetrics> {
  const endpointCalls: string[] = [];
  const requestBodies: Array<{ endpoint: string; body: string }> = [];
  // Hold author rendering constant so the comparison measures only channel
  // locator overhead rather than unrelated users.info cache warming.
  getUserCache().set("U01ABCDEF23", "Example User");
  const select = vi.fn(async (_title: string, options: string[]) =>
    options.find((option) => option.includes("as-is")),
  );
  const input = vi.fn(async () => undefined);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const endpoint = endpointFrom(request);
      endpointCalls.push(endpoint);
      requestBodies.push({ endpoint, body: String(init?.body ?? "") });

      if (endpoint === "conversations.replies") {
        const payload = options.repliesError
          ? { ok: false, error: options.repliesError }
          : {
              ok: true,
              messages: [
                {
                  type: "message",
                  user: "U01ABCDEF23",
                  text: "Example direct message",
                  ts: MESSAGE_TS,
                },
              ],
              has_more: false,
            };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: false, error: "team_access_not_granted" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  const ctx = {
    cwd: "/tmp/sf-slack-direct-permalink-test",
    hasUI: true,
    modelRegistry: {
      getApiKeyForProvider: vi.fn(async () => "xoxp-test"),
    },
    ui: { select, input },
  };

  const tool = captureSlackTool();
  const result = (await tool.execute!(
    "tool-call" as never,
    params as never,
    undefined as never,
    undefined as never,
    ctx as never,
  )) as ToolResult;

  // The legacy branch performs a best-effort, fire-and-forget channel-name
  // lookup after the read. Give it a turn to settle so the A metrics include
  // that extra resolver call and cannot leak into the B measurement.
  await new Promise<void>((resolve) => setImmediate(resolve));

  return {
    result,
    endpointCalls,
    requestBodies,
    selectCalls: select.mock.calls.length,
    inputCalls: input.mock.calls.length,
  };
}

function count(metrics: ScenarioMetrics, endpoint: string): number {
  return metrics.endpointCalls.filter((value) => value === endpoint).length;
}

describe("direct permalink A/B behavior", () => {
  beforeEach(() => {
    getChannelCache().clear();
    getUserCache().clear();
    setDetectedTeamId(undefined);
    vi.stubEnv("SLACK_TEAM_ID", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    getChannelCache().clear();
    getUserCache().clear();
    setDetectedTeamId(undefined);
  });

  it("B removes resolver calls and HITL selection while preserving the exact read", async () => {
    const legacyA = await runScenario({
      action: "thread",
      channel: CHANNEL_ID,
      ts: MESSAGE_TS,
      fields: "full",
      limit: 25,
      cursor: "cursor-example",
    });

    vi.unstubAllGlobals();
    getChannelCache().clear();

    const directB = await runScenario({
      action: "thread",
      message_url: MESSAGE_URL,
      // Reproduce Pi's eager tool-argument shape: omitted optional strings can
      // arrive as empty placeholders and must not conflict with message_url.
      channel: "",
      ts: "",
      query: "",
      oldest: "",
      latest: "",
      fields: "full",
      limit: 25,
      cursor: "cursor-example",
    });

    expect(legacyA.result.details).toMatchObject({
      ok: true,
      action: "thread",
      channel: CHANNEL_ID,
      ts: MESSAGE_TS,
      count: 1,
    });
    expect(count(legacyA, "conversations.replies")).toBe(1);
    expect(count(legacyA, "conversations.info")).toBeGreaterThan(0);
    expect(count(legacyA, "conversations.list")).toBeGreaterThan(0);
    expect(count(legacyA, "assistant.search.context")).toBeGreaterThan(0);
    expect(legacyA.selectCalls).toBe(1);

    expect(directB.result.details).toMatchObject({
      ok: true,
      action: "thread",
      channel: CHANNEL_ID,
      ts: MESSAGE_TS,
      locator: "message_url",
      count: 1,
    });
    expect(count(directB, "conversations.replies")).toBe(1);
    expect(directB.endpointCalls).toEqual(["conversations.replies"]);
    const directReadParams = new URLSearchParams(directB.requestBodies[0].body);
    expect(directReadParams.get("channel")).toBe(CHANNEL_ID);
    expect(directReadParams.get("ts")).toBe(MESSAGE_TS);
    expect(directReadParams.get("limit")).toBe("25");
    expect(directReadParams.get("cursor")).toBe("cursor-example");
    expect(directB.selectCalls).toBe(0);
    expect(directB.inputCalls).toBe(0);

    // Branch-effectiveness comparison: B preserves the successful read while
    // reducing the current resolver fanout to one API call and no dialog.
    expect({
      legacyA: {
        apiCalls: legacyA.endpointCalls.length,
        resolverCalls: legacyA.endpointCalls.filter(
          (endpoint) => endpoint !== "conversations.replies",
        ).length,
        selectCalls: legacyA.selectCalls,
      },
      directB: {
        apiCalls: directB.endpointCalls.length,
        resolverCalls: directB.endpointCalls.filter(
          (endpoint) => endpoint !== "conversations.replies",
        ).length,
        selectCalls: directB.selectCalls,
      },
    }).toEqual({
      legacyA: { apiCalls: 8, resolverCalls: 7, selectCalls: 1 },
      directB: { apiCalls: 1, resolverCalls: 0, selectCalls: 0 },
    });
  });

  it("rejects malformed and conflicting direct locators before API or UI work", async () => {
    const malformed = await runScenario({
      action: "thread",
      message_url: "https://not-slack.example/archives/D01ABCDEF23/p1700000000100001",
    });

    vi.unstubAllGlobals();

    const conflicting = await runScenario({
      action: "thread",
      message_url: MESSAGE_URL,
      channel: CHANNEL_ID,
      ts: MESSAGE_TS,
    });

    expect(malformed.result.details).toMatchObject({
      ok: false,
      action: "thread",
      reason: "invalid_message_url",
    });
    expect(malformed.endpointCalls).toEqual([]);
    expect(malformed.selectCalls).toBe(0);

    expect(conflicting.result.details).toMatchObject({
      ok: false,
      action: "thread",
      reason: "conflicting_locators",
    });
    expect(conflicting.endpointCalls).toEqual([]);
    expect(conflicting.selectCalls).toBe(0);
  });

  it("returns the direct endpoint error without resolver or UI fallback", async () => {
    const unavailable = await runScenario(
      { action: "thread", message_url: MESSAGE_URL },
      { repliesError: "channel_not_found" },
    );

    expect(unavailable.result.details).toMatchObject({
      ok: false,
      reason: "channel_not_found",
    });
    expect(unavailable.endpointCalls).toEqual(["conversations.replies"]);
    expect(unavailable.selectCalls).toBe(0);
    expect(unavailable.inputCalls).toBe(0);
  });
});
