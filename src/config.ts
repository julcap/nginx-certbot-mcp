export const NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
export const NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
export const ARCHIVE_DIR = "/etc/nginx/sites-archived"; // create this dir with correct perms before use
export const LETSENCRYPT_LIVE = "/etc/letsencrypt/live";
export const WEBSOCKET_TEMPLATE_PATH = new URL("../templates/websocket.conf.template", import.meta.url);
