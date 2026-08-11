import net from "node:net";
import { mkdtempSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeSocketParent, fixedPeerCredentialReader, startBrokerServer } from "../tailscale-broker/server.js";
import type { Broker, PeerIdentity } from "../tailscale-broker/broker.js";

// A minimal Broker stand-in that records the request it received.
function fakeBroker(handler: (req: unknown, peer: PeerIdentity) => Promise<unknown>): Broker {
  return { handle: handler } as unknown as Broker;
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function request(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => client.end(payload));
    let out = "";
    client.on("data", (d) => (out += d.toString()));
    client.on("end", () => resolve(out));
    client.on("error", reject);
  });
}

describe("assertSafeSocketParent", () => {
  it("rejects a symlinked parent", () => {
    expect(() =>
      assertSafeSocketParent("/x/s.sock", { isDirectory: () => true, isSymbolicLink: () => true, mode: 0o755, uid: 0 }),
    ).toThrow(/symlink/);
  });
  it("rejects a group/world-writable parent", () => {
    expect(() =>
      assertSafeSocketParent("/x/s.sock", { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o777, uid: 0 }),
    ).toThrow(/writable/);
  });
  it("accepts a safe root-owned 0755 parent", () => {
    assertSafeSocketParent("/x/s.sock", { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o755, uid: 0 });
  });
});

describe("broker socket server (end to end)", () => {
  it("refuses to start when the parent directory is a symlink", () => {
    const base = mkdtempSync(path.join(tmpdir(), "brk-"));
    const real = path.join(base, "real");
    mkdirSync(real);
    const link = path.join(base, "link");
    symlinkSync(real, link);
    expect(() =>
      startBrokerServer({
        socketPath: path.join(link, "broker.sock"),
        broker: fakeBroker(async () => ({ ok: true, result: {} })),
        peerReader: fixedPeerCredentialReader({ uid: 1000, gid: 2000, pid: null }),
      }),
    ).toThrow(/symlink/);
  });

  it("round-trips a request and passes peer credentials through", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "brk-"));
    chmodSync(dir, 0o755);
    const socketPath = path.join(dir, "broker.sock");
    let seenPeer: PeerIdentity | null = null;
    const server = startBrokerServer({
      socketPath,
      broker: fakeBroker(async (_req, peer) => {
        seenPeer = peer;
        return { ok: true, result: { leases: [] } };
      }),
      peerReader: fixedPeerCredentialReader({ uid: 1000, gid: 2000, pid: null }),
    });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const res = await request(socketPath, `${JSON.stringify({ v: 1, op: "list" })}\n`);
    expect(JSON.parse(res)).toEqual({ ok: true, result: { leases: [] } });
    expect(seenPeer).toEqual({ uid: 1000, gid: 2000, pid: null });
  });

  it("rejects an oversized request frame", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "brk-"));
    chmodSync(dir, 0o755);
    const socketPath = path.join(dir, "broker.sock");
    const server = startBrokerServer({
      socketPath,
      broker: fakeBroker(async () => ({ ok: true, result: {} })),
      peerReader: fixedPeerCredentialReader({ uid: 1000, gid: 2000, pid: null }),
    });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const res = await request(socketPath, `${" ".repeat(9000)}\n`);
    expect(JSON.parse(res)).toMatchObject({ ok: false, code: "frame_too_large" });
  });
});
