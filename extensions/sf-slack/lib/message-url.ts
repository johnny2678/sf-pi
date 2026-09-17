/* SPDX-License-Identifier: Apache-2.0 */
/** Strict parsing for canonical Slack message permalinks used as exact reads. */

const SLACK_WORKSPACE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.slack\.com$/i;
const MESSAGE_PATH_RE = /^\/archives\/([CGD][A-Z0-9]{8,})\/p(\d{10,})(\d{6})\/?$/;

export interface SlackMessageLocator {
  conversationId: string;
  ts: string;
}

export class InvalidSlackMessageUrlError extends Error {
  constructor() {
    super(
      "Invalid Slack message_url. Expected a canonical HTTPS Slack workspace message permalink.",
    );
    this.name = "InvalidSlackMessageUrlError";
  }
}

/**
 * Parse the path-owned conversation ID and message timestamp from a canonical
 * Slack permalink. Query parameters such as `thread_ts` and `cid` are allowed
 * because Slack emits them for thread links, but they never override the path.
 */
export function parseSlackMessageUrl(input: string): SlackMessageLocator {
  const value = String(input || "").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidSlackMessageUrlError();
  }

  if (
    url.protocol !== "https:" ||
    !SLACK_WORKSPACE_HOST_RE.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new InvalidSlackMessageUrlError();
  }

  const match = MESSAGE_PATH_RE.exec(url.pathname);
  if (!match) throw new InvalidSlackMessageUrlError();

  return {
    conversationId: match[1],
    ts: `${match[2]}.${match[3]}`,
  };
}
