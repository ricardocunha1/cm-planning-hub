# Build stage: compile the SPA into static files.
FROM proxy.criticalmanufacturing.io/library/node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Unprivileged variant: runs as non-root (UID 101, GID 0) with group-writable
# conf.d/cache/pid paths, so it also works under OpenShift's random UID.
FROM proxy.criticalmanufacturing.io/library/nginx:alpine

# Rendered by the image entrypoint (envsubst) into conf.d/default.conf.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/dist /usr/share/nginx/html

# Pre-create /tmp dirs nginx needs (writable by any UID)
RUN mkdir -p /tmp/nginx/client_temp /tmp/nginx/proxy_temp \
             /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp \
             /tmp/nginx/scgi_temp && \
    chmod -R 777 /tmp/nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
