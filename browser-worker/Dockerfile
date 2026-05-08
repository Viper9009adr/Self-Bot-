# Runtime Stage
FROM mcr.microsoft.com/playwright:v1.59.1-jammy
WORKDIR /app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.3.10 /usr/local/bin/bun /usr/local/bin/bun
COPY browser-worker/package.json ./
RUN bun install
COPY browser-worker/server.ts ./
RUN bun --version
USER pwuser
ENV HOME=/home/pwuser
EXPOSE 3002
CMD ["bun", "run", "server.ts"]
