FROM golang:1.22-alpine AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o /out/caretaker-agent-setup.exe ./cmd/caretaker-agent

FROM node:20-alpine AS build
WORKDIR /app
COPY hub/package.json hub/package-lock.json* ./
RUN npm install
COPY hub/tsconfig.json ./
COPY hub/src ./src
COPY hub/public ./public
RUN npm run build && cp -r public dist/public

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV CARETAKER_DATA=/data
COPY hub/package.json hub/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=agent /out/caretaker-agent-setup.exe /app/downloads/caretaker-agent-setup.exe
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/index.js"]
