"""Python test repo service (docs/16 §2 fixture). Minimal FastAPI app for the
sandbox/image-build tests + agent harness verification (§7.2)."""
from fastapi import FastAPI

app = FastAPI(title="forge-test-python-service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "forge-test-python-service"}


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "forge-test-python-service", "docs": "/docs"}
