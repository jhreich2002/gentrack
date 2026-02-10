# =============================================================
# GenTrack — Multi-stage Docker Build
# Stage 1: Fetch EIA data + Build React app
# Stage 2: Serve with nginx (tiny ~25MB image)
# =============================================================

# --- Stage 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts 2>/dev/null || npm install

# Copy source
COPY . .

# Fetch fresh EIA data (uses build arg for API key)
ARG VITE_EIA_API_KEY
ARG GEMINI_API_KEY
ENV VITE_EIA_API_KEY=${VITE_EIA_API_KEY}
ENV GEMINI_API_KEY=${GEMINI_API_KEY}

# Run the data ingestion script to produce public/data/plants.json
RUN npx tsx scripts/fetch-eia-data.ts

# Build the React app (Vite produces static files in dist/)
RUN npm run build

# --- Stage 2: Serve ---
FROM nginx:alpine AS production

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built app from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
