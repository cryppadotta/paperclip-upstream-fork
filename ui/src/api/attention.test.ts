import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("./client", () => ({ api: mockApi }));

import { attentionApi } from "./attention";

describe("attentionApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ items: [] });
  });

  it("encodes feed filters, decide sorting, and cursor pagination", async () => {
    await attentionApi.list("company-1", {
      includeDismissed: true,
      archived: true,
      activitySince: "2026-08-01T00:00:00.000Z",
      activityUntil: "2026-08-01T23:59:59.999Z",
      queue: "release review",
      sort: "decide",
      cursor: "next/page",
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/attention?includeDismissed=true&archived=true&activitySince=2026-08-01T00%3A00%3A00.000Z&activityUntil=2026-08-01T23%3A59%3A59.999Z&queue=release+review&sort=decide&cursor=next%2Fpage&limit=25",
    );
  });

  it("requests a complete filtered snapshot for complete-set actions", async () => {
    await attentionApi.list("company-1", { queue: "release review", all: true });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/attention?all=true&queue=release+review",
    );
  });

  it("paginates unscoped complete-feed views", async () => {
    mockApi.get
      .mockResolvedValueOnce({
        companyId: "company-1",
        generatedAt: "2026-08-03T12:00:00.000Z",
        totalCount: 2,
        deskBadgeCount: 2,
        nextCursor: "next/page",
        countsBySourceKind: {},
        items: [{ id: "attention-1" }],
      })
      .mockResolvedValueOnce({
        companyId: "company-1",
        generatedAt: "2026-08-03T12:00:01.000Z",
        totalCount: 2,
        deskBadgeCount: 2,
        nextCursor: null,
        countsBySourceKind: {},
        items: [{ id: "attention-2" }],
      });

    const feed = await attentionApi.listAll("company-1", { includeDismissed: true });

    expect(mockApi.get).toHaveBeenNthCalledWith(
      1,
      "/companies/company-1/attention?includeDismissed=true&limit=100",
    );
    expect(mockApi.get).toHaveBeenNthCalledWith(
      2,
      "/companies/company-1/attention?includeDismissed=true&cursor=next%2Fpage&limit=100",
    );
    expect(feed.items.map((item) => item.id)).toEqual(["attention-1", "attention-2"]);
    expect(feed.nextCursor).toBeNull();
  });

  it("omits the query delimiter when no options are supplied", async () => {
    await attentionApi.list("company-1");

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/attention");
  });
});
