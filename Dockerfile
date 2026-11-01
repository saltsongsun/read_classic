# 웹 앱 + 악보 인식 서버를 한 번에 실행하는 이미지
#   docker build -t read-classic .
#   docker run -p 8000:8000 read-classic      → http://localhost:8000
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 libgl1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY server/requirements.txt server/requirements.txt
# 인식 모델(약 90MB)을 이미지에 미리 받아 둔다
RUN pip install --no-cache-dir -r server/requirements.txt && homr --init
COPY server/ server/
COPY --from=web /app/dist dist
ENV STATIC_DIR=/srv/dist
EXPOSE 8000
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
