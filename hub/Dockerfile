FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && cp -r public dist/public

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV CARETAKER_DATA=/data
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/index.js"]
