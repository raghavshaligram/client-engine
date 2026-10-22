# Reads Texas HOA certificates: text PDFs directly, scanned ones with OCR. Built once, on first use.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
COPY ocr.sh /ocr.sh
RUN chmod +x /ocr.sh
ENTRYPOINT ["/ocr.sh"]
