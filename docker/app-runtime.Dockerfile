# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# DuckView data-app runtime — the image the `docker` and `kubernetes` app runtimes start, one container per app.
#   Python + Streamlit, Dash, Gradio, pandas, pyarrow, altair, plotly and the DuckView SDK; non-root (1001), nothing else.
#   DuckView streams (Docker) or mounts (Kubernetes) the app's source, sets DUCKVIEW_URL / DUCKVIEW_TOKEN /
#   DUCKVIEW_WORKSPACE, and runs `streamlit run <entry>` (or `python <entry>` for Dash / Gradio) with its settings. requirements.txt, when allowed, is
#   pip-installed into /tmp/.local at start (the root filesystem stays read-only).
#
#   docker build -f docker/app-runtime.Dockerfile -t anbproject/duckview-app-runtime:latest .
# ---------------------------------------------------------------------------
ARG PYTHON_VERSION=3.12
FROM python:${PYTHON_VERSION}-slim
ARG DUCKVIEW_VERSION=dev
LABEL org.opencontainers.image.title="DuckView app runtime" \
      org.opencontainers.image.description="Runs DuckView data apps (Streamlit, Dash, Gradio) in their own container" \
      org.opencontainers.image.version="${DUCKVIEW_VERSION}"
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    STREAMLIT_SERVER_HEADLESS=true \
    HOME=/tmp \
    PYTHONUSERBASE=/tmp/.local \
    PATH=/tmp/.local/bin:$PATH
COPY packages/sdk-python /opt/duckview-sdk
RUN pip install "streamlit>=1.46" "dash>=2.17" "gradio>=4.44" pandas pyarrow altair plotly /opt/duckview-sdk \
 && rm -rf /opt/duckview-sdk \
 && groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app --home-dir /tmp --shell /usr/sbin/nologin app
USER 1001:1001
WORKDIR /tmp
EXPOSE 8501
HEALTHCHECK NONE
CMD ["streamlit", "hello"]
