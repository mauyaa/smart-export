import os

os.environ["SMARTEXPORTS_DEMO_MODE"] = "true"

from fastapi.testclient import TestClient

from api.main import app


client = TestClient(app)


def test_demo_health_returns_ok():
    assert client.get("/health").json() == {"status": "ok"}


def test_demo_check_normalizes_crop_case():
    response = client.post(
        "/check",
        json={"fertilizer_name": "ORTHENE 75 SP", "crop_name": "French Beans"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["fertilizer"] == "Orthene 75SP"
    assert data["crop"] == "French beans"
    assert data["risk_level"] == "Risky"
    assert data["alternative_product"]
    assert data["matched_via"].startswith("fuzzy")


def test_demo_safe_product_returns_safe():
    response = client.post(
        "/check",
        json={"fertilizer_name": "Muriate of Potash", "crop_name": "Avocado"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["risk_level"] == "Safe"
    assert data["explanation"]


def test_demo_unknown_product_routes_to_escalation():
    response = client.post(
        "/check",
        json={"fertilizer_name": "zzz-not-real", "crop_name": "Avocado"},
    )

    assert response.status_code == 404


def test_demo_extract_label_returns_sample_product():
    response = client.post(
        "/extract-label",
        files={"file": ("orthene-label.jpg", b"demo-image", "image/jpeg")},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["product_name"] == "Orthene 75SP"
    assert data["confidence"] == "medium"


def test_demo_escalate_returns_received():
    response = client.post(
        "/escalate",
        json={"fertilizer_name": "zzz-not-real", "crop_name": "Avocado"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "received"
