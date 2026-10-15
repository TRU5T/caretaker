# Base images are pinned by digest; Dependabot proposes updates.
FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -buildid=" -o /out/caretaker-agent-setup.exe ./cmd/caretaker-agent \
  && cd /out && sha256sum caretaker-agent-setup.exe > caretaker-agent-setup.exe.sha256

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
COPY hub/package.json hub/package-lock.json ./
RUN npm ci
COPY hub/tsconfig.json ./
COPY hub/src ./src
COPY hub/public ./public
RUN npm run build && cp -r public dist/public

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
# su-exec drops root after fixing ownership of /data (older installs created it as root)
RUN apk add --no-cache su-exec
ENV NODE_ENV=production
ENV CARETAKER_DATA=/data
LABEL org.opencontainers.image.title="Caretaker Hub" \
  org.opencontainers.image.description="Moonlight/Apollo companion — wake, unlock, sleep a Windows gaming PC" \
  org.opencontainers.image.source="https://github.com/TRU5T/caretaker" \
  org.opencontainers.image.licenses="MIT"
COPY hub/package.json hub/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=agent /out/caretaker-agent-setup.exe /out/caretaker-agent-setup.exe.sha256 /app/downloads/
COPY hub/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
