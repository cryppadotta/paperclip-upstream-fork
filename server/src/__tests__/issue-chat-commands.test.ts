import { describe, expect, it } from "vitest";
import {
  buildUnsupportedChatCommandReply,
  isHumanIssueChatCommandComment,
  parseLeadingIssueChatCommand,
} from "../services/issue-chat-commands.js";

describe("issue chat command router helpers", () => {
  it("parses only leading slash commands", () => {
    expect(parseLeadingIssueChatCommand("/goal ship the feature")).toEqual({
      name: "goal",
      args: "ship the feature",
      raw: "/goal ship the feature",
    });
    expect(parseLeadingIssueChatCommand("  /goal status\nignored")).toEqual({
      name: "goal",
      args: "status",
      raw: "/goal status",
    });
    expect(parseLeadingIssueChatCommand("please run /goal ship it")).toBeNull();
  });

  it("only treats undeleted user comments as dispatch-authorized", () => {
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "user", authorUserId: "user-1" })).toBe(true);
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "agent", authorUserId: null })).toBe(false);
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "system", authorUserId: null })).toBe(false);
    expect(isHumanIssueChatCommandComment({ body: "/goal x", authorType: "user", authorUserId: "user-1", deletedAt: new Date() })).toBe(false);
  });

  it("builds fail-loud unsupported /goal replies without prompt passthrough summary", () => {
    const reply = buildUnsupportedChatCommandReply({
      adapterType: "codex_local",
      command: {
        name: "goal",
        raw: "/goal ship it",
        args: "ship it",
        sourceCommentId: "comment-1",
        sourceAuthorType: "user",
      },
    });

    expect(reply.message).toContain("requires a Codex agent using the app-server goal runtime");
    expect(reply.result.exitCode).toBe(0);
    expect(reply.result.summary).toBe("");
    expect(reply.result.resultJson?.chatCommand).toMatchObject({
      name: "goal",
      supported: false,
      sourceCommentId: "comment-1",
    });
  });
});
