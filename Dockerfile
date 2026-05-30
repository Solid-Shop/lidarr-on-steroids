FROM docker.io/library/node:24-alpine AS deemix

RUN apk add --no-cache git python3 make g++ && \
    npm install -g pnpm turbo

RUN git clone https://github.com/bambanah/deemix.git /app && \
    cd /app && git checkout 26f76240b4d16cf472b51cd35fe305801a2fea27

WORKDIR /app
RUN pnpm install --frozen-lockfile

# Prevent crash when a Deezer channel returns unavailable tracks
RUN sed -i 's/=> channelNewReleases(dz, c)/=> channelNewReleases(dz, c).catch(() => [])/g' \
    /app/packages/webui/src/server/routes/api/get/newReleases.ts

# Track-picker reverse-proxy: forwards Deemix /picker-api/* → loopback sidecar on 7171,
# so the sidecar's port never needs to be published on the host.
COPY root/app/track-picker/deemix-patch/pickerProxy.ts /app/packages/webui/src/server/pickerProxy.ts
RUN set -eu; \
    MAIN=/app/packages/webui/src/server/main.ts; \
    test -f "$MAIN"; \
    # Insert our import on the line directly after the express import.
    # .js extension is required because Deemix's tsconfig uses moduleResolution: nodenext.
    sed -i 's|^\(import express, { type Express } from "express";\)$|\1\nimport { pickerProxy } from "./pickerProxy.js";|' "$MAIN"; \
    # Mount the proxy just before the API routes are registered.
    sed -i 's|^\(\s*\)\(registerApis(app);\)|\1app.use("/picker-api", pickerProxy);\n\1\2|' "$MAIN"; \
    # Fail loudly if either patch didn't take.
    grep -q '^import { pickerProxy }' "$MAIN" || { echo "pickerProxy import patch failed"; head -20 "$MAIN"; exit 1; }; \
    grep -q '"/picker-api"' "$MAIN" || { echo "pickerProxy app.use patch failed"; grep -n 'registerApis' "$MAIN"; exit 1; }; \
    echo "pickerProxy patch applied"

RUN pnpm turbo build --filter=deemix-webui...


FROM ghcr.io/hotio/lidarr:nightly-804c007

LABEL maintainer="solidshop"

ENV DEEMIX_SINGLE_USER=true
ENV AUTOCONFIG=true
ENV CLEAN_DOWNLOADS=true
ENV PUID=1000
ENV PGID=1000

# flac2mp3
RUN apk add --no-cache ffmpeg && \
    rm -rf /var/lib/apt/lists/*
COPY lidarr-flac2mp3/root/usr /usr

# deemix
RUN apk add --no-cache bash nodejs
COPY --from=deemix /app /deemix-app
VOLUME ["/config_deemix", "/downloads"]
EXPOSE 6595

# arl-watch
RUN apk add --no-cache inotify-tools && \
    rm -rf /var/lib/apt/lists/*

COPY root /
RUN find /etc/services.d -type f -name run -exec sed -i 's/\r$//' {} + && \
    find /usr/local/bin -type f -name '*.sh' -exec sed -i 's/\r$//' {} + && \
    find /app/track-picker -type f \( -name '*.js' -o -name '*.css' \) -exec sed -i 's/\r$//' {} + 2>/dev/null || true; \
    chmod +x /etc/services.d/*/run && \
    chmod +x /usr/local/bin/*.sh

VOLUME ["/config", "/music"]
EXPOSE 6595 8686
