import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ComposioApiError, createComposioClient } from "./composio.js";

type Fixture = {
  baseUrl: string;
  requests: Array<{ method: string; url: string; apiKey: string | undefined }>;
  close(): Promise<void>;
};

async function startFixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Fixture> {
  const requests: Fixture["requests"] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      apiKey: Array.isArray(request.headers["x-api-key"])
        ? request.headers["x-api-key"]?.[0]
        : request.headers["x-api-key"],
    });
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v3.1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("Composio REST client", () => {
  it("validates an API key with the cheap toolkit-list call", async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [] }));
    });
    fixtures.push(fixture);

    const client = createComposioClient({ apiKey: "ak_fixture", baseUrl: fixture.baseUrl });
    await expect(client.validateApiKey()).resolves.toBeUndefined();

    expect(fixture.requests).toEqual([{
      method: "GET",
      url: "/api/v3.1/toolkits?limit=1",
      apiKey: "ak_fixture",
    }]);
  });

  it("rejects an invalid key without reflecting the provider response body", async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "provider-controlled secret detail" }));
    });
    fixtures.push(fixture);

    const client = createComposioClient({ apiKey: "bad_fixture", baseUrl: fixture.baseUrl });
    const error = await client.validateApiKey().catch((caught) => caught);

    expect(error).toBeInstanceOf(ComposioApiError);
    expect(error).toMatchObject({ status: 401, message: "Composio rejected the API key." });
    expect(String(error)).not.toContain("provider-controlled");
  });

  it("lists typed toolkits from the project behind the key", async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        items: [{
          slug: "github",
          name: "GitHub",
          auth_schemes: ["oauth2"],
          meta: { tools_count: 42, logo: "https://example.test/github.png" },
        }],
        next_cursor: "next-page",
      }));
    });
    fixtures.push(fixture);

    const client = createComposioClient({ apiKey: "ak_fixture", baseUrl: fixture.baseUrl });
    const result = await client.listToolkits({ limit: 10, cursor: "page-1" });

    expect(result).toEqual({
      items: [{
        slug: "github",
        name: "GitHub",
        auth_schemes: ["oauth2"],
        meta: { tools_count: 42, logo: "https://example.test/github.png" },
      }],
      next_cursor: "next-page",
    });
    expect(fixture.requests[0]?.url).toBe("/api/v3.1/toolkits?cursor=page-1&limit=10");
  });
});
