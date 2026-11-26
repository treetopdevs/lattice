# Multi-stage Dockerfile for the unified Lattice multi-app WSS demo on Fly.io
# (LatticeCarrierServer + Township Phoenix LiveView + Lattice Browser Starter + Caddy)

FROM node:22-bookworm-slim AS web-builder
WORKDIR /src

# Build @treetopdevs/lattice-client
COPY clients/lattice-client/package.json clients/lattice-client/package-lock.json ./clients/lattice-client/
RUN npm --prefix clients/lattice-client ci
COPY clients/lattice-client ./clients/lattice-client
RUN npm --prefix clients/lattice-client run build

# Copy @treetopdevs/lattice-shell-kit (source-only TS package)
COPY clients/lattice-shell-kit ./clients/lattice-shell-kit

# Build @treetopdevs/lattice-browser-starter
COPY clients/lattice-browser-starter/package.json clients/lattice-browser-starter/package-lock.json ./clients/lattice-browser-starter/
RUN npm --prefix clients/lattice-browser-starter ci
COPY clients/lattice-browser-starter ./clients/lattice-browser-starter
RUN npm --prefix clients/lattice-browser-starter run build

# Install root node_modules for township_web esbuild (vue + @dagrejs/dagre)
COPY package.json package-lock.json ./
RUN npm ci --omit=optional

FROM caddy:2-alpine AS caddy-bin

FROM elixir:1.19.5-otp-28 AS runtime
ENV MIX_ENV=prod
ENV MIX_HOME=/app/.mix
ENV HEX_HOME=/app/.hex
ENV LANG=C.UTF-8

RUN apt-get update -y && \
    apt-get install -y --no-install-recommends curl ca-certificates openssl git && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 1000 lattice && \
    useradd -m -u 1000 -g 1000 -s /bin/bash lattice

COPY --from=caddy-bin /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app

# Copy only the 4 umbrella apps needed for the live multi-app demo (no Rustler/township_bench)
COPY mix.exs mix.lock ./
COPY config ./config
COPY apps/lattice_core ./apps/lattice_core
COPY apps/lattice_web_socket ./apps/lattice_web_socket
COPY apps/lattice_carrier_server ./apps/lattice_carrier_server
COPY apps/township_web ./apps/township_web
COPY artifacts ./artifacts
COPY scripts/demo_ecosystem_prepare.exs scripts/demo_ecosystem_township_live.exs ./scripts/
COPY deploy/fly-demo/Caddyfile ./Caddyfile
COPY deploy/fly-demo/entrypoint.sh ./entrypoint.sh
COPY --from=web-builder /src/clients/lattice-browser-starter/dist ./web
COPY --from=web-builder /src/node_modules ./node_modules

RUN chmod +x /app/entrypoint.sh && \
    mix local.hex --force && \
    mix local.rebar --force && \
    mix deps.get --only prod && \
    mix compile && \
    (cd apps/township_web && mix esbuild.install --if-missing && mix assets.build) && \
    mkdir -p /data && \
    chown -R lattice:lattice /app /data

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
