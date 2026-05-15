# Runtime Stage
FROM oven/bun:1.3.10
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install Chrome for Puppeteer (WhatsApp adapter)
RUN apt-get update && apt-get install -y \
    curl \
    chromium \
    chromium-sandbox \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/bun/.cache/puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY . .
RUN chown -R bun:bun /app
USER bun
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
