# Slim Python image — Railway auto-detects and layer-caches efficiently.
FROM python:3.12-slim

# Non-buffered stdout so Railway sees logs in real time.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Railway assigns $PORT dynamically.
ENV PORT=8000
EXPOSE 8000

# Single-worker Uvicorn — Railway scales horizontally via replicas, not workers.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --log-config app/logging_config.json
