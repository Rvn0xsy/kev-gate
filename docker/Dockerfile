FROM python:3.13-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

RUN git clone --depth 1 https://github.com/jaredpalmer/kev.git /opt/kev
WORKDIR /opt/kev
RUN uv sync --extra serve

ENV HF_HOME=/data/hf \
	HF_HUB_DISABLE_PROGRESS_BARS=1 \
	GATE_RUN=jaredpalmer/kev-4b \
	GATE_PORT=8010

VOLUME ["/data/hf"]
EXPOSE 8010

CMD ["sh", "-c", "uv run --extra serve python -m kev.serve --run \"$GATE_RUN\" --host 0.0.0.0 --port \"$GATE_PORT\""]
