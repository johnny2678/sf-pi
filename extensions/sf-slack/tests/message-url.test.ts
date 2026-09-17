/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { InvalidSlackMessageUrlError, parseSlackMessageUrl } from "../lib/message-url.ts";

describe("parseSlackMessageUrl", () => {
  it.each(["C01ABCDEF23", "G01ABCDEF23", "D01ABCDEF23"])(
    "parses a canonical %s message permalink",
    (conversationId) => {
      expect(
        parseSlackMessageUrl(
          `https://example.slack.com/archives/${conversationId}/p1700000000100001`,
        ),
      ).toEqual({ conversationId, ts: "1700000000.100001" });
    },
  );

  it("uses the path locator when Slack thread query parameters are present", () => {
    expect(
      parseSlackMessageUrl(
        "https://example.slack.com/archives/D01ABCDEF23/p1700000000100001" +
          "?thread_ts=1600000000.200002&cid=C01DIFFERENT",
      ),
    ).toEqual({
      conversationId: "D01ABCDEF23",
      ts: "1700000000.100001",
    });
  });

  it("accepts a trailing slash and preserves a future longer seconds component", () => {
    expect(
      parseSlackMessageUrl(
        "https://example-workspace.slack.com/archives/C01ABCDEF23/p11700000000100001/",
      ),
    ).toEqual({
      conversationId: "C01ABCDEF23",
      ts: "11700000000.100001",
    });
  });

  it.each([
    "http://example.slack.com/archives/C01ABCDEF23/p1700000000100001",
    "https://slack.com/archives/C01ABCDEF23/p1700000000100001",
    "https://example.slack.com.evil.test/archives/C01ABCDEF23/p1700000000100001",
    "https://user@example.slack.com/archives/C01ABCDEF23/p1700000000100001",
    "https://example.slack.com:8443/archives/C01ABCDEF23/p1700000000100001",
    "https://example.slack.com/client/T01ABCDEF23/C01ABCDEF23",
    "https://example.slack.com/archives/X01ABCDEF23/p1700000000100001",
    "https://example.slack.com/archives/C01ABCDEF23/p170000000010001",
    "https://example.slack.com/archives/C01ABCDEF23/p1700000000100001#reply",
    "not a URL",
  ])("rejects a non-canonical locator: %s", (value) => {
    expect(() => parseSlackMessageUrl(value)).toThrow(InvalidSlackMessageUrlError);
  });
});
