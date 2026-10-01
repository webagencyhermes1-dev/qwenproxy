FROM mcr.microsoft.com/playwright:v1.62.1-jammy

# Process helpers (dumb-init for zombie reaping, gosu for safe user switching)
# plus build-essential/python3 for compiling native addons (better-sqlite3) on ARM64.
# Note: Base image already includes Node 22 LTS, so no external NodeSource curl needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 dumb-init gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prevent duplicate browser downloads during npm install
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies first for better Docker layer caching
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Install Patchright's patched stealth Chromium for the container's architecture (AMD64 / ARM64)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx patchright install --with-deps chromium \
  && chown -R pwuser:pwuser /ms-playwright

# Copy application source and configuration
COPY docker-entrypoint.sh ./
COPY bin ./bin
COPY src ./src

# Prepare persistent directories with proper non-root permissions
RUN mkdir -p /app/data/db /app/data/qwen_profiles /tmp/playwright \
  && chown -R pwuser:pwuser /app /tmp/playwright \
  && chmod +x /app/docker-entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 7936

# Deep readiness probe: 200 only when >= 1 account can serve traffic.
# start-period covers cold-start browser warmup; uses $PORT when overridden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'7936')+'/readyz').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENV NODE_ENV=production

# Use dumb-init to avoid zombie processes from Playwright child processes
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
