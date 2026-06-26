"""
SmartExports — CI Smoke Tests
Hits the live deployed API at the URL set in the API_BASE_URL environment
variable (stored as a GitHub secret). Tests are intentionally lightweight —
they verify the API is alive, endpoints respond correctly, and core logic
produces expected risk verdicts.

Run locally:
    API_BASE_URL=https://smartexports-api.onrender.com python -m pytest tests/ -v
"""

import os
import time
import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "https://smartexports-api.onrender.com")

MAX_RETRIES = 3
RETRY_DELAY = 15


def api_get(path: str) -> requests.Response:
    url = f"{BASE_URL}{path}"
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.get(url, timeout=60)
            return r
        except requests.exceptions.Timeout:
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
    pytest.fail(f"GET {url} timed out after {MAX_RETRIES} attempts")


def api_post(path: str, payload: dict) -> requests.Response:
    url = f"{BASE_URL}{path}"
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.post(url, json=payload, timeout=60)
            return r
        except requests.exceptions.Timeout:
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
    pytest.fail(f"POST {url} timed out after {MAX_RETRIES} attempts")


class TestHealth:
    def test_health_returns_ok(self):
        r = api_get("/health")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        assert r.json() == {"status": "ok"}


class TestCheck:
    def test_known_risky_product_returns_risky(self):
        r = api_post("/check", {
            "fertilizer_name": "Orthene 75SP",
            "crop_name": "French beans"
        })
        assert r.status_code == 200
        data = r.json()
        assert data["risk_level"] == "Risky"
        assert data["fertilizer"] == "Orthene 75SP"
        assert data["crop"] == "French beans"
        assert data["alternative_product"]

    def test_risky_product_has_evidence(self):
        r = api_post("/check", {
            "fertilizer_name": "Orthene 75SP",
            "crop_name": "French beans"
        })
        data = r.json()
        evidence = data["evidence"]
        has_evidence = (
            len(evidence.get("regulatoryHits", [])) > 0 or
            len(evidence.get("rejectionHits", [])) > 0 or
            len(evidence.get("organicHits", [])) > 0
        )
        assert has_evidence, "Risky verdict must have supporting evidence"

    def test_risky_product_has_explanation(self):
        r = api_post("/check", {
            "fertilizer_name": "Orthene 75SP",
            "crop_name": "French beans"
        })
        data = r.json()
        assert data["explanation"].strip()
        assert len(data["explanation"]) > 50

    def test_safe_product_returns_safe(self):
        r = api_post("/check", {
            "fertilizer_name": "Muriate of Potash",
            "crop_name": "Avocado"
        })
        assert r.status_code == 200
        assert r.json()["risk_level"] == "Safe"

    def test_new_risky_product_thunder(self):
        r = api_post("/check", {
            "fertilizer_name": "Thunder 145SC",
            "crop_name": "Avocado"
        })
        assert r.status_code == 200
        assert r.json()["risk_level"] == "Risky"

    def test_fuzzy_name_matching(self):
        r = api_post("/check", {
            "fertilizer_name": "ORTHENE 75 SP",
            "crop_name": "French beans"
        })
        assert r.status_code == 200
        data = r.json()
        assert data["risk_level"] == "Risky"
        assert "fuzzy" in data["matched_via"]

    def test_unknown_product_returns_404(self):
        r = api_post("/check", {
            "fertilizer_name": "CompletelyUnknownXYZProduct999",
            "crop_name": "French beans"
        })
        assert r.status_code == 404

    def test_response_has_required_fields(self):
        r = api_post("/check", {
            "fertilizer_name": "Orthene 75SP",
            "crop_name": "French beans"
        })
        data = r.json()
        for field in ["fertilizer", "crop", "risk_level", "explanation",
                      "next_step", "alternative_product", "evidence", "matched_via"]:
            assert field in data, f"Missing required field: {field}"

    def test_risk_level_is_valid_value(self):
        r = api_post("/check", {
            "fertilizer_name": "Orthene 75SP",
            "crop_name": "French beans"
        })
        assert r.json()["risk_level"] in ("Safe", "Risky", "Unclear")


class TestEscalate:
    def test_escalate_returns_received(self):
        r = api_post("/escalate", {
            "fertilizer_name": "Unknown Product",
            "crop_name": "Avocado",
            "farmer_contact": "ci-test@smartexports.ke",
            "notes": "Automated CI test"
        })
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "received"
        assert "message" in data

    def test_escalate_works_without_optional_fields(self):
        r = api_post("/escalate", {
            "fertilizer_name": "Unknown Product",
            "crop_name": "French beans"
        })
        assert r.status_code == 200

class TestCrops:
    def test_crops_returns_list(self):
        r = api_get("/crops")
        assert r.status_code == 200
        data = r.json()
        assert "crops" in data
        assert len(data["crops"]) >= 11

    def test_crops_search_returns_results(self):
        r = api_get("/crops?q=french")
        assert r.status_code == 200
        data = r.json()
        assert any("French" in c for c in data["crops"])

    def test_crops_unknown_query_returns_empty_not_error(self):
        r = api_get("/crops?q=xyzunknowncrop999")
        assert r.status_code == 200
        data = r.json()
        assert "crops" in data
        assert "note" in data


class TestCORS:
    def test_cors_header_present(self):
        """CORS headers are only returned when request includes an Origin header."""
        url = f"{BASE_URL}/check"
        r = requests.post(
            url,
            json={"fertilizer_name": "Orthene 75SP", "crop_name": "French beans"},
            headers={"Origin": "http://localhost:3000"},
            timeout=60
        )
        assert r.status_code == 200
        assert "access-control-allow-credentials" in r.headers, \
            "CORS header missing — frontend will be blocked"
