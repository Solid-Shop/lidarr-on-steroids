FROM docker.io/library/node:26-alpine AS deemix

RUN apk add --no-cache git python3 make g++ && \
    npm install -g pnpm turbo

RUN git clone https://github.com/bambanah/deemix.git /app && \
    cd /app && git checkout 26f76240b4d16cf472b51cd35fe305801a2fea27

WORKDIR /app
RUN pnpm install --frozen-lockfile

# Prevent crash when a Deezer channel returns unavailable tracks
RUN sed -i 's/=> channelNewReleases(dz, c)/=> channelNewReleases(dz, c).catch(() => [])/g' \
    /app/packages/webui/src/server/routes/api/get/newReleases.ts

RUN pnpm turbo build --filter=deemix-webui...


FROM ghcr.io/hotio/lidarr:nightly-3.1.3.4970

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

# caddy: in-container reverse proxy that fronts Lidarr on the published port (8686).
# Forwards /picker-api/* to the loopback track-picker sidecar; everything else to
# Lidarr (relocated to internal port 8685 by /etc/cont-init.d/01-lidarr-port).
RUN apk add --no-cache caddy

COPY root /
RUN find /etc/services.d -type f -name run -exec sed -i 's/\r$//' {} + && \
    find /etc/cont-init.d -type f -exec sed -i 's/\r$//' {} + 2>/dev/null || true; \
    find /usr/local/bin -type f -name '*.sh' -exec sed -i 's/\r$//' {} + && \
    find /app/track-picker -type f \( -name '*.js' -o -name '*.css' \) -exec sed -i 's/\r$//' {} + 2>/dev/null || true; \
    chmod +x /etc/services.d/*/run && \
    chmod +x /etc/cont-init.d/* 2>/dev/null || true; \
    chmod +x /usr/local/bin/*.sh

VOLUME ["/config", "/music"]
EXPOSE 6595 8686
