FROM python:3.12-alpine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY collector.py /app/collector.py
RUN addgroup -S collector && adduser -S -G collector collector
USER collector
CMD ["python", "-u", "/app/collector.py"]
