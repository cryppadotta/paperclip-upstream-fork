import { createPrivateKey, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { signRequestEnvelope } from "@paperclip/connect-protocol";
import { logger } from "../middleware/logger.js";
import {
  connectionBrokerService,
  connectionBrokerStore,
  createSignedConnectBrokerClient,
  type ConnectBrokerTransport,
} from "./connection-broker.js";
import {
  connectionRelayDispatcher,
  connectionRelaySecretResolver,
  connectionRelayStore,
  pollRelayChannel,
  processAndDispatchConnectionRelay,
} from "./connection-relay.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { secretService } from "./secrets.js";

type ConnectionRuntimeConfig = {
  baseUrl: string;
  instanceId: string;
  keyId: string;
  privateKeyB64: string;
  pollIntervalMs: number;
};

function readConnectionRuntimeConfig(env: NodeJS.ProcessEnv): ConnectionRuntimeConfig | null {
  const baseUrl = env.PAPERCLIP_CONNECT_BASE_URL?.trim();
  const instanceId = env.PAPERCLIP_CONNECT_INSTANCE_ID?.trim();
  const privateKeyB64 = env.PAPERCLIP_CONNECT_PRIVATE_KEY_B64?.trim();
  if (!baseUrl && !instanceId && !privateKeyB64) return null;
  if (!baseUrl || !instanceId || !privateKeyB64) {
    logger.warn("Connection runtime is disabled because its configuration is incomplete");
    return null;
  }
  const parsedInterval = Number(env.PAPERCLIP_CONNECT_POLL_INTERVAL_MS ?? "1000");
  return {
    baseUrl: new URL(baseUrl).toString(),
    instanceId,
    keyId: env.PAPERCLIP_CONNECT_KEY_ID?.trim() || "identity-v1",
    privateKeyB64,
    pollIntervalMs: Number.isFinite(parsedInterval) && parsedInterval >= 250 ? parsedInterval : 1000,
  };
}

export function createConnectionRuntime(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; env?: NodeJS.ProcessEnv } = {},
) {
  const config = readConnectionRuntimeConfig(options.env ?? process.env);
  if (!config) return null;

  const privateKey = createPrivateKey({
    key: Buffer.from(config.privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const transport: ConnectBrokerTransport = {
    async request(path, compactJws) {
      const response = await fetch(new URL(path, config.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope: compactJws }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => ({})),
      };
    },
  };
  const client = createSignedConnectBrokerClient({
    instanceId: config.instanceId,
    keyId: config.keyId,
    privateKey,
    transport,
  });
  const secrets = secretService(db);
  const broker = connectionBrokerService({
    client,
    store: connectionBrokerStore(db),
    enabled: true,
    vault: {
      async put(input) {
        const suffix = randomUUID();
        const secret = await secrets.create(input.companyId, {
          name: `connection-${input.purpose}-${input.connectionId}-${suffix}`,
          key: `connection-${input.purpose}-${input.connectionId}-${suffix}`,
          provider: "local_encrypted",
          value: input.value,
          description: `Connector ${input.purpose} material for ${input.connectionId}`,
        });
        return {
          secretId: secret.id,
          versionSelector: "latest",
          configPath: `broker.${input.purpose}`,
          required: true,
          label: `Connector ${input.purpose}`,
        };
      },
    },
  });

  const store = connectionRelayStore(db);
  const dispatcher = connectionRelayDispatcher(db, { pluginWorkerManager: options.pluginWorkerManager });
  const resolveRelaySecret = connectionRelaySecretResolver(db);
  let stopped = false;
  let running = false;

  const signedRequest = async (path: string, body: unknown) => {
    const compactJws = signRequestEnvelope({
      body,
      instanceId: config.instanceId,
      keyId: config.keyId,
      privateKey,
      path,
    });
    const response = await transport.request(path, compactJws);
    if (response.status >= 400) throw new Error(`Connector service request failed (${response.status})`);
    return response.body;
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await pollRelayChannel({
        baseUrl: config.baseUrl,
        createSession: async () => {
          const result = await signedRequest("/v1/relay/token", {}) as { channelToken?: unknown };
          if (typeof result.channelToken !== "string") throw new Error("Connector service did not return a relay token");
          return { channelToken: result.channelToken, streamUrl: "/v1/relay/poll" };
        },
        onEnvelope: async ({ body, signature, timestamp }) => {
          const envelope = JSON.parse(body.toString("utf8")) as { connectionPublicRef?: unknown };
          if (typeof envelope.connectionPublicRef !== "string") throw new Error("Relay envelope is missing connectionPublicRef");
          const result = await processAndDispatchConnectionRelay(store, dispatcher, {
            rawBody: body,
            signature,
            timestamp,
            relaySecret: await resolveRelaySecret(envelope.connectionPublicRef),
          });
          if (result.status === "failed") throw new Error("Relay destination dispatch failed");
        },
        acknowledge: async (deliveryIds) => {
          for (const deliveryId of deliveryIds) await signedRequest("/v1/relay/ack", { deliveryId });
        },
      });
    } catch (error) {
      if (!stopped) logger.warn({ err: error }, "Connection relay poll failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.pollIntervalMs);
  timer.unref?.();
  void tick();

  return {
    broker,
    close() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
