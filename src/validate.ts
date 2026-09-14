// Strict validation for anything that ends up in a filename, config, or shell arg.
// Never interpolate unvalidated input into a shell command or file path.

const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export function isValidDomain(domain: string): boolean {
  return HOSTNAME_RE.test(domain);
}

export function assertValidDomain(domain: string): void {
  if (!isValidDomain(domain)) {
    throw new Error(`Invalid domain: "${domain}" does not look like a real hostname.`);
  }
}

// Upstream host can be a hostname or an internal IP (e.g. Proxmox VM) - keep it strict too.
const UPSTREAM_RE = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?)+$/;

export function assertValidUpstreamHost(host: string): void {
  if (!UPSTREAM_RE.test(host)) {
    throw new Error(`Invalid upstream host: "${host}"`);
  }
}

export function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
}
