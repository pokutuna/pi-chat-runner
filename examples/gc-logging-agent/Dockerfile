# Extends the pi-chat-runner base image with CLIs and skills for
# investigating Google Cloud Logging.
ARG BASE_IMAGE=pi-chat-runner:local
FROM ${BASE_IMAGE}

# gcloud CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg apt-transport-https \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

# duckdb (installer puts it under root's $HOME; copy it somewhere on PATH for all users)
RUN curl -fsSL https://install.duckdb.org | sh \
  && cp /root/.duckdb/cli/latest/duckdb /usr/local/bin/duckdb

# uv / uvx
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
  && cp /root/.local/bin/uv /root/.local/bin/uvx /usr/local/bin/

COPY --chown=1001:1001 skills/ /home/agent/.pi/agent/skills/
COPY --chown=1001:1001 extensions/ /home/agent/.pi/agent/extensions/
