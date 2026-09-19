import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ReloadResult {
  success: boolean;
  test_output: string;
  hint?: string;
}

export async function reloadNginx(): Promise<ReloadResult> {
  try {
    const test = await execFileAsync("sudo", ["nginx","-t"]);
    // Test passed - safe to reload.
    // TODO: this needs the process to have permission to run this without a password
    // prompt. Add a narrow sudoers entry, e.g.:
    //   youruser ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/sbin/nginx -t
    await execFileAsync("sudo", ["systemctl", "reload", "nginx"]);
    return { success: true, test_output: test.stdout + test.stderr };
  } catch (err: any) {
    return {
      success: false,
      test_output: err.stderr ?? String(err),
      hint:
        "nginx was not reloaded. If this follows a recent create_site, update_site, restore_site or " +
        "rollback_site, call list_site_backups and rollback_site to return to the previous config.",
    };
  }
}
