import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NginxStatus {
  running: boolean;
  version: string;
}

export async function getNginxStatus(): Promise<NginxStatus> {
  let running: boolean;
  try {
    // Without sudo, a non-root `systemctl is-active` needs a D-Bus session
    // that isn't guaranteed to exist (e.g. minimal containers have no dbus
    // installed at all) - go through sudo like reload_nginx does, rather
    // than depending on that.
    await execFileAsync("sudo", ["systemctl", "is-active", "--quiet", "nginx"]);
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
