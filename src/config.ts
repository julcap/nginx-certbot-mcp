export const NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
export const NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
export const ARCHIVE_DIR = "/etc/nginx/sites-archived"; // create this dir with correct perms before use
export const BACKUP_DIR = "/etc/nginx/sites-backups"; // created by the wrapper's `backup` action
export const LETSENCRYPT_LIVE = "/etc/letsencrypt/live";
export const WEBSOCKET_TEMPLATE_PATH = new URL("../templates/websocket.conf.template", import.meta.url);

export const NGINX_ACCESS_LOG = "/var/log/nginx/access.log";
export const NGINX_ERROR_LOG = "/var/log/nginx/error.log";
export const MAX_LOG_LINES = 1000;

// Archive filenames are "<domain>.<YYYYMMDDTHHMMSS>", written by the
// wrapper's `archive` action - keep this in sync with that format.
export const ARCHIVE_FILENAME_RE = /^(.+)\.(\d{8}T\d{6})$/;
