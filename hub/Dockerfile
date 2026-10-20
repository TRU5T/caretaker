# Base images are pinned by digest; Dependabot proposes updates.
FROM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -buildid=" -o /out/caretaker-agent-setup.exe ./cmd/caretaker-agent \
  && cd /out && sha256sum caretaker-agent-setup.exe > caretaker-agent-setup.exe.sha256

FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app
COPY hub/package.json hub/package-lock.json ./
RUN npm ci
COPY hub/tsconfig.json ./
COPY hub/src ./src
COPY hub/public ./public
RUN npm run build && cp -r public dist/public

FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
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
