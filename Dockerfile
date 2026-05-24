FROM --platform=$TARGETPLATFORM docker.io/library/node:24-alpine AS deemix

ARG TARGETPLATFORM
ARG BUILDPLATFORM

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN echo "Building for TARGETPLATFORM=$TARGETPLATFORM | BUILDPLATFORM=$BUILDPLATFORM"
RUN corepack enable && \
    apk add --no-cache git python3 make g++
RUN pnpm install -g turbo

RUN git clone https://github.com/bambanah/deemix.git /app && \
    cd /app && git checkout 26f76240b4d16cf472b51cd35fe305801a2fea27

WORKDIR /app
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=deemix-webui...


FROM ghcr.io/hotio/lidarr:release-634da4a

LABEL maintainer="youegraillot"

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
RUN apk add --no-cache nodejs
COPY --from=deemix /app /deemix-app
VOLUME ["/config_deemix", "/downloads"]
EXPOSE 6595

# arl-watch
RUN apk add --no-cache inotify-tools && \
    rm -rf /var/lib/apt/lists/*

COPY root /
RUN chmod +x /etc/services.d/*/run && \
    chmod +x /usr/local/bin/*.sh

VOLUME ["/config", "/music"]
EXPOSE 6595 8686
