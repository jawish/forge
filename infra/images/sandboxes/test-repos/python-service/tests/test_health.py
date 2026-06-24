"""Health test for the Python test repo (docs/16 §2 fixture). The agent's
verification loop runs these (docs/01 closed-loop verification)."""
from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
