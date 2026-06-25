import os
from types import SimpleNamespace

os.environ["SMARTEXPORTS_DEMO_MODE"] = "true"

from fastapi.testclient import TestClient

from api import main
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


def test_explanation_falls_back_when_model_returns_empty(monkeypatch):
    def create_empty_explanation(**_kwargs):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=""))]
        )

    monkeypatch.setattr(main, "DEMO_MODE", False)
    monkeypatch.setattr(
        main,
        "llm_client",
        SimpleNamespace(
            chat=SimpleNamespace(
                completions=SimpleNamespace(create=create_empty_explanation)
            )
        ),
    )

    explanation = main.generate_grounded_explanation(
        "Orthene 75SP",
        "French beans",
        "Risky",
        [{"pathNodes": [{"props": {}}, {"props": {"regulationCode": "EU MRL Pesticides"}}]}],
    )

    assert "Orthene 75SP is flagged as Risky for French beans" in explanation
    assert "EU MRL Pesticides" in explanation


def test_risky_check_uses_curated_alternative_when_graph_has_none(monkeypatch):
    monkeypatch.setattr(main, "DEMO_MODE", False)
    monkeypatch.setattr(main, "resolve_fertilizer_name", lambda name: ("Orthene 75SP", "exact"))
    monkeypatch.setattr(main, "resolve_crop_name", lambda crop: "French beans")
    monkeypatch.setattr(
        main,
        "get_risk_match",
        lambda _fertilizer, _crop: {
            "fertilizer": "Orthene 75SP",
            "crop": "French beans",
            "riskLevel": "Risky",
            "regulatoryHits": [],
            "rejectionHits": [],
            "organicHits": [],
        },
    )
    monkeypatch.setattr(main, "get_explanation_path", lambda _fertilizer: [])
    monkeypatch.setattr(
        main,
        "generate_grounded_explanation",
        lambda _fertilizer, _crop, _risk, _evidence: "Fallback explanation.",
    )
    monkeypatch.setattr(main, "get_alternative", lambda _fertilizer, _crop: None)

    response = client.post(
        "/check",
        json={"fertilizer_name": "Orthene 75SP", "crop_name": "French beans"},
    )

    assert response.status_code == 200
    assert response.json()["alternative_product"] == "Muriate of Potash"
