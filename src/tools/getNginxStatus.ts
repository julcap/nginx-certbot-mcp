import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NginxStatus {
  running: boolean;
  version: string;
}

// Both commands are safe to run as any user - no sudo needed.
export async function getNginxStatus(): Promise<NginxStatus> {
  let running: boolean;
  try {
    await execFileAsync("systemctl", ["is-active", "--quiet", "nginx"]);
    running = true;
  } catch {
    running = false;
  }

  let version = "unknown";
  try {
    // nginx prints its version to stderr, not stdout.
    const { stderr } = await execFileAsync("nginx", ["-v"]);
    version = stderr.trim();
  } catch (err: any) {
    version = `could not determine version: ${err.message ?? err}`;
  }

  return { running, version };
}
