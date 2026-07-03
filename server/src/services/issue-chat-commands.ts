import type {
  AdapterChatCommandInvocation,
  AdapterExecutionResult,
} from "../adapters/index.js";

export function parseLeadingIssueChatCommand(body: string): { name: string; args: string; raw: string } | null {
  const firstLine = body.replace(/^\s+/, "").split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i);
  if (!match) return null;
  const name = match[1]?.toLowerCase() ?? "";
  if (!name) return null;
  return {
    name,
    args: match[2]?.trim() ?? "",
    raw: firstLine.trim(),
  };
}

export function isHumanIssueChatCommandComment(comment: {
  body: string;
  authorType?: string | null;
  authorUserId?: string | null;
  deletedAt?: Date | string | null;
} | null): comment is {
  body: string;
  authorType: "user";
  authorUserId: string | null;
  deletedAt?: Date | string | null;
} {
  return Boolean(comment && !comment.deletedAt && comment.authorType === "user");
}

export function buildUnsupportedChatCommandReply(input: {
  command: AdapterChatCommandInvocation;
  adapterType: string;
}): { message: string; result: AdapterExecutionResult } {
  const message =
    input.command.name === "goal"
      ? "`/goal` requires a Codex agent using the app-server goal runtime. Enable the Codex goal runtime in the assignee's adapter settings, then try again."
      : `Unsupported issue-thread command: \`/${input.command.name}\`.`;
  return {
    message,
    result: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      provider: "paperclip",
      biller: "paperclip",
      model: input.adapterType,
      billingType: "fixed",
      costUsd: null,
      resultJson: {
        chatCommand: {
          name: input.command.name,
          supported: false,
          sourceCommentId: input.command.sourceCommentId,
        },
      },
      summary: "",
    },
  };
}
