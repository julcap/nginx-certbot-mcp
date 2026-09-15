# Disposable sandbox for exercising nginx-certbot-mcp's nginx/certbot tools
# against a real (but throwaway) nginx + certbot install, without touching a
# real production box. Runs systemd as PID 1 so `sudo systemctl reload nginx`
# and friends work exactly as they do in production - see README's "Docker
# sandbox" section for how to run it (needs --privileged + a cgroup mount).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# systemd + the trimming below is the standard "systemd in Docker" recipe:
# strip the unit files that hang or fail with no real hardware/session
# (udev, ttys, random-seed, machine-id inheritance, etc.) so `/sbin/init`
# reaches a stable multi-user target instead of spinning.
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      systemd systemd-sysv sudo ca-certificates curl gnupg \
    && rm -rf \
      /lib/systemd/system/multi-user.target.wants/* \
      /etc/systemd/system/*.wants/* \
      /lib/systemd/system/local-fs.target.wants/* \
      /lib/systemd/system/sockets.target.wants/*udev* \
      /lib/systemd/system/sockets.target.wants/*initctl* \
      /lib/systemd/system/basic.target.wants/* \
      /lib/systemd/system/anaconda.target.wants/* \
    && rm -rf /var/lib/apt/lists/*

# Node 20 LTS (Ubuntu 24.04's own `nodejs` package is older, and
# @aws-sdk/client-route-53 will require >=20 from early 2027).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/nginx-certbot-mcp
COPY . .
# Installs nginx, certbot, and the certbot plugins this project needs -
# same idempotent script a bare-metal box uses.
RUN bash scripts/install-deps.sh

RUN npm install && npm run build

RUN useradd -m -s /bin/bash mcpuser \
    && bash scripts/setup.sh mcpuser \
    && chown -R mcpuser:mcpuser /opt/nginx-certbot-mcp

# MCP Inspector's default ports - `npm run inspect` prints the actual URL
# (with its session token) on startup; check that output rather than
# assuming these.
EXPOSE 6274 6277

CMD ["/sbin/init"]
