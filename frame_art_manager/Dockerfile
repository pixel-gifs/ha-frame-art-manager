ARG BUILD_FROM

# --- Stage 1: compile the collage builder (React/Vite) to static assets ---
FROM $BUILD_FROM AS collage-ui-build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs npm

WORKDIR /collage-ui
COPY app/collage-ui/package*.json ./
RUN npm ci --no-audit --no-fund
COPY app/collage-ui/ ./
RUN npm run build

# --- Stage 2: runtime image (ships compiled assets, no build at runtime) ---
FROM $BUILD_FROM

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install Node.js, git, and git-lfs
RUN apk add --no-cache \
    nodejs \
    npm \
    git \
    git-lfs \
    openssh-client \
    python3 \
    make \
    g++ \
    jq \
    && git lfs install

# Set working directory
WORKDIR /app

# Copy package files
COPY app/package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy application files
COPY app/ ./

# Compiled collage builder from the build stage (served at /collage)
COPY --from=collage-ui-build /collage-ui/dist ./collage-ui/dist

# Create run script
COPY run.sh /
RUN chmod a+x /run.sh

# Expose port
EXPOSE 8099

# Run the add-on
CMD [ "/run.sh" ]
