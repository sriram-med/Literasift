# LiteraSift host (Node 22). Article files and the SQLite state live in the /data volume.
# Optional tools for scanned PDFs (OCR): build with --build-arg WITH_OCR=1
FROM node:22-bookworm-slim
ARG WITH_OCR=0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && if [ "$WITH_OCR" = "1" ]; then apt-get install -y --no-install-recommends tesseract-ocr poppler-utils; fi \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/literasift
COPY package.json ./
COPY worker ./worker
COPY server ./server
RUN mkdir -p /data && chown -R node:node /data /opt/literasift
USER node
ENV PORT=8787 HOST=0.0.0.0 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/index.mjs"]
