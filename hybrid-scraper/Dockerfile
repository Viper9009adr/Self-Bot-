# Use the official Playwright image which has all browser dependencies
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

# Install Bun
RUN apt-get update && apt-get install -y curl unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN bun install

# Copy source
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["bun", "run", "server.ts"]
