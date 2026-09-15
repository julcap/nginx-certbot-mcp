import { connect } from "node:net";
import { assertValidUpstreamHost, assertValidPort } from "../validate.js";

export interface CheckUpstreamHealthInput {
  upstream_host: string;
  upstream_port: number;
  timeout_ms?: number;
}

export interface CheckUpstreamHealthResult {
  reachable: boolean;
  message: string;
}

export function checkUpstreamHealth(
  input: CheckUpstreamHealthInput
): Promise<CheckUpstreamHealthResult> {
  const { upstream_host, upstream_port, timeout_ms = 3000 } = input;
  assertValidUpstreamHost(upstream_host);
  assertValidPort(upstream_port);

  return new Promise((resolve) => {
    const socket = connect({ host: upstream_host, port: upstream_port, timeout: timeout_ms });

    const finish = (reachable: boolean, message: string) => {
      socket.destroy();
      resolve({ reachable, message });
    };

    socket.once("connect", () =>
      finish(true, `TCP connect to ${upstream_host}:${upstream_port} succeeded.`)
    );
    socket.once("timeout", () =>
      finish(false, `TCP connect to ${upstream_host}:${upstream_port} timed out after ${timeout_ms}ms.`)
    );
    socket.once("error", (err) =>
      finish(false, `TCP connect to ${upstream_host}:${upstream_port} failed: ${err.message}`)
    );
  });
}
