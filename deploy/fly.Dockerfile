# Used by fly.toml. Kept out of the repository root so Railway keeps its default Node build.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# Fly mounts volumes owned by root; a non-root user could not write job records or the budget ledger to /data.
EXPOSE 8080
CMD ["node", "server.mjs"]
