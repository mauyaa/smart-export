"""
SmartExports API — end-to-end risk-check service.

Flow per request:
1. Receive fertilizer name + crop name (from OCR/manual entry on frontend)
2. Resolve fertilizer name fuzzily if exact match fails (handles typos/OCR noise)
3. Run risk-match Cypher -> get Safe/Risky/Unclear + supporting facts
4. Run explanation-path Cypher -> get the shortest evidence chain
5. Feed ONLY that retrieved evidence into the LLM prompt (GraphRAG —
   model is grounded, not allowed to invent regulatory claims)
6. Run alternative-suggestion Cypher if risk == Risky
7. Return a single result card to the frontend

Run with: uvicorn main:app --reload --port 8000
Production GraphRAG env vars: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, FEATHERLESS_API_KEY
Use SMARTEXPORTS_DEMO_MODE=true for local startup without production secrets.
"""

import os
import json
import time
import logging
import difflib
import base64
from typing import Any, Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError, ServiceUnavailable
from openai import OpenAI, APIError, APIConnectionError
from fastapi import UploadFile, File

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("smartexports")

REQUIRED_ENV_VARS = ["NEO4J_PASSWORD", "FEATHERLESS_API_KEY"]
missing = [v for v in REQUIRED_ENV_VARS if not os.environ.get(v)]
SMARTEXPORTS_DEMO_MODE = os.environ.get("SMARTEXPORTS_DEMO_MODE", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
DEMO_MODE = SMARTEXPORTS_DEMO_MODE

if missing and not DEMO_MODE:
    raise RuntimeError(
        f"Missing required environment variable(s): {', '.join(missing)}. "
        f"Copy api/.env.example to api/.env and fill in real values, or set "
        f"SMARTEXPORTS_DEMO_MODE=true for local demo mode."
    )
if DEMO_MODE:
    logger.warning(
        "SmartExports API is running in demo mode. Set Neo4j and Featherless "
        "credentials and SMARTEXPORTS_DEMO_MODE=false for production GraphRAG."
    )

NEO4J_URI = os.environ.get("NEO4J_URI", "neo4j://127.0.0.1:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD")
FEATHERLESS_MODEL = os.getenv("FEATHERLESS_MODEL", "").strip() or "Qwen/Qwen2.5-7B-Instruct"
FEATHERLESS_VISION_MODEL = os.environ.get("FEATHERLESS_VISION_MODEL", "google/gemma-3-27b-it")
DEFAULT_CORS_ORIGINS_LIST = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "https://smart-export.vercel.app",
    "https://smart-export-mauyaas-projects.vercel.app",
    "https://smartexports.vercel.app",
    "https://front-end-nu-rosy-90.vercel.app",
]

env_origins = os.environ.get("CORS_ORIGINS", "")
CORS_ORIGINS = DEFAULT_CORS_ORIGINS_LIST.copy()
if env_origins:
    CORS_ORIGINS.extend([o.strip() for o in env_origins.split(",") if o.strip()])

# Remove duplicates
CORS_ORIGINS = list(set(CORS_ORIGINS))

driver = None if DEMO_MODE else GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

llm_client = None if DEMO_MODE else OpenAI(
    api_key=os.environ.get("FEATHERLESS_API_KEY"),
    base_url="https://api.featherless.ai/v1",
)

limiter = Limiter(key_func=get_remote_address, default_limits=["30/minute"])

app = FastAPI(title="SmartExports API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CYPHER_DIR = os.path.join(os.path.dirname(__file__), "..", "cypher")
RISK_MATCH_QUERY = open(os.path.join(CYPHER_DIR, "03_risk_match_query.cypher")).read()
EXPLANATION_PATH_QUERY = open(os.path.join(CYPHER_DIR, "04_explanation_path.cypher")).read()
ALTERNATIVE_QUERY = open(os.path.join(CYPHER_DIR, "06_alternative_suggestion.cypher")).read()


class CheckRequest(BaseModel):
    fertilizer_name: str
    crop_name: str


class ResultCard(BaseModel):
    fertilizer: str
    crop: str
    risk_level: str
    explanation: str
    next_step: str
    alternative_product: Optional[str] = None
    evidence: dict
    matched_via: str = "exact"


class EscalateRequest(BaseModel):
    fertilizer_name: str
    crop_name: str
    farmer_contact: Optional[str] = None
    notes: Optional[str] = None


_CACHE: dict = {}
_CACHE_TTL_SECONDS = 60 * 30

DEMO_CROPS = [
    "French beans",
    "Snow peas",
    "Avocado",
    "Passion fruit",
    "Maize",
    "Tea",
    "Coffee",
    "Macadamia",
    "Mango",
    "Cut flowers",
    "Pineapple",
]

DEMO_PRODUCTS: dict[str, dict[str, Any]] = {
    "Orthene 75SP": {
        "brand": "Generic AgroDealer KE",
        "risk_level": "Risky",
        "substances": [{"name": "Acephate", "category": "organophosphate_pesticide"}],
        "regulatory_hits": [
            {
                "substance": "Acephate",
                "category": "organophosphate_pesticide",
                "restriction": {
                    "regulationCode": "EU MRL Pesticides",
                    "regulationName": "EU Pesticides Database - Maximum Residue Levels",
                    "limit": 0.01,
                    "unit": "mg/kg",
                },
                "rejectionCase": None,
                "organicRestriction": None,
            }
        ],
        "rejection_hits": [
            {
                "substance": "Acephate",
                "category": "organophosphate_pesticide",
                "restriction": None,
                "rejectionCase": {
                    "id": "KE-2020-001",
                    "date": "2020-06-15",
                    "summary": "Kenyan fine beans rejected at EU border for excess Acephate residue.",
                    "source": "Expert committee report",
                },
                "organicRestriction": None,
            }
        ],
        "organic_hits": [
            {
                "substance": "Acephate",
                "category": "organophosphate_pesticide",
                "restriction": None,
                "rejectionCase": None,
                "organicRestriction": {
                    "regulationCode": "EU 2021/1165",
                    "note": "not authorized for organic use",
                },
            }
        ],
        "alternative": "Muriate of Potash",
    },
    "Thunder 145SC": {
        "brand": "Generic AgroDealer KE",
        "risk_level": "Risky",
        "substances": [{"name": "Chlorpyrifos", "category": "organophosphate_pesticide"}],
        "regulatory_hits": [
            {
                "substance": "Chlorpyrifos",
                "category": "organophosphate_pesticide",
                "restriction": {
                    "regulationCode": "EU MRL Pesticides",
                    "regulationName": "EU Pesticides Database - Maximum Residue Levels",
                    "limit": 0.01,
                    "unit": "mg/kg",
                },
                "rejectionCase": None,
                "organicRestriction": None,
            }
        ],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": "CAN (Calcium Ammonium Nitrate)",
    },
    "Duduthrin 1.75EC": {
        "brand": "Generic AgroDealer KE",
        "risk_level": "Risky",
        "substances": [{"name": "Chlorpyrifos", "category": "organophosphate_pesticide"}],
        "regulatory_hits": [
            {
                "substance": "Chlorpyrifos",
                "category": "organophosphate_pesticide",
                "restriction": {
                    "regulationCode": "EU MRL Pesticides",
                    "regulationName": "EU Pesticides Database - Maximum Residue Levels",
                    "limit": 0.01,
                    "unit": "mg/kg",
                },
                "rejectionCase": None,
                "organicRestriction": None,
            }
        ],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": "Muriate of Potash",
    },
    "Dudu Diazinon 60EC": {
        "brand": "Generic AgroDealer KE",
        "risk_level": "Risky",
        "substances": [{"name": "Diazinon", "category": "organophosphate_pesticide"}],
        "regulatory_hits": [
            {
                "substance": "Diazinon",
                "category": "organophosphate_pesticide",
                "restriction": {
                    "regulationCode": "EU MRL Pesticides",
                    "regulationName": "EU Pesticides Database - Maximum Residue Levels",
                    "limit": 0.01,
                    "unit": "mg/kg",
                },
                "rejectionCase": None,
                "organicRestriction": None,
            }
        ],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": "Muriate of Potash",
    },
    "Ridomil Gold MZ 68WG": {
        "brand": "Syngenta",
        "risk_level": "Risky",
        "substances": [{"name": "Mancozeb", "category": "fungicide"}],
        "regulatory_hits": [
            {
                "substance": "Mancozeb",
                "category": "fungicide",
                "restriction": {
                    "regulationCode": "EU MRL Pesticides",
                    "regulationName": "EU Pesticides Database - Maximum Residue Levels",
                    "limit": 0.05,
                    "unit": "mg/kg",
                },
                "rejectionCase": None,
                "organicRestriction": None,
            }
        ],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": "Muriate of Potash",
    },
    "NPK 17:17:17": {
        "brand": "MEA Fertilizer",
        "risk_level": "Risky",
        "substances": [
            {"name": "Cadmium", "category": "heavy_metal"},
            {"name": "Nitrogen (Urea form)", "category": "macronutrient"},
        ],
        "regulatory_hits": [
            {
                "substance": "Cadmium",
                "category": "heavy_metal",
                "restriction": {
                    "regulationCode": "EU 2019/1009",
                    "regulationName": "Fertilising Products Regulation",
                    "limit": 60,
                    "unit": "mg/kg P2O5",
                },
                "rejectionCase": None,
                "organicRestriction": None,
            }
        ],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": "CAN (Calcium Ammonium Nitrate)",
    },
    "Muriate of Potash": {
        "brand": "Yara",
        "risk_level": "Safe",
        "substances": [{"name": "Potassium chloride", "category": "macronutrient"}],
        "regulatory_hits": [],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": None,
    },
    "CAN (Calcium Ammonium Nitrate)": {
        "brand": "Toyota Tsusho",
        "risk_level": "Safe",
        "substances": [{"name": "Nitrogen (Urea form)", "category": "macronutrient"}],
        "regulatory_hits": [],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": None,
    },
    "Urea": {
        "brand": "Generic AgroDealer KE",
        "risk_level": "Safe",
        "substances": [{"name": "Nitrogen (Urea form)", "category": "macronutrient"}],
        "regulatory_hits": [],
        "rejection_hits": [],
        "organic_hits": [],
        "alternative": None,
    },
}


def cache_get(key: str):
    entry = _CACHE.get(key)
    if not entry:
        return None
    value, expires_at = entry
    if time.time() > expires_at:
        _CACHE.pop(key, None)
        return None
    return value


def cache_set(key: str, value):
    _CACHE[key] = (value, time.time() + _CACHE_TTL_SECONDS)


def run_query(tx, query, **params):
    result = tx.run(query, **params)
    return [record.data() for record in result]


def get_all_fertilizer_names() -> list:
    if DEMO_MODE:
        return list(DEMO_PRODUCTS.keys())

    with driver.session() as session:
        rows = session.execute_read(
            run_query, "MATCH (f:Fertilizer) RETURN f.name AS name"
        )
        return [r["name"] for r in rows]


def get_all_crop_names() -> list:
    if DEMO_MODE:
        return DEMO_CROPS

    with driver.session() as session:
        rows = session.execute_read(
            run_query, "MATCH (c:Crop) RETURN c.name AS name"
        )
        return [r["name"] for r in rows]


def normalize_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def resolve_fertilizer_name(fertilizer_name: str) -> tuple:
    all_names = get_all_fertilizer_names()
    if fertilizer_name in all_names:
        return fertilizer_name, "exact"

    normalized_input = normalize_name(fertilizer_name)
    normalized_map = {normalize_name(n): n for n in all_names}

    if normalized_input in normalized_map:
        return normalized_map[normalized_input], f"fuzzy:{fertilizer_name}"

    close = difflib.get_close_matches(normalized_input, list(normalized_map.keys()), n=1, cutoff=0.6)
    if close:
        return normalized_map[close[0]], f"fuzzy:{fertilizer_name}"

    return fertilizer_name, "exact"


def resolve_crop_name(crop_name: str) -> str:
    all_names = get_all_crop_names()
    if crop_name in all_names:
        return crop_name

    normalized_input = normalize_name(crop_name)
    normalized_map = {normalize_name(n): n for n in all_names}

    if normalized_input in normalized_map:
        return normalized_map[normalized_input]

    close = difflib.get_close_matches(normalized_input, list(normalized_map.keys()), n=1, cutoff=0.75)
    if close:
        return normalized_map[close[0]]

    return crop_name


def demo_substance_findings(product: dict[str, Any]) -> list:
    hits = (
        product.get("regulatory_hits", [])
        + product.get("rejection_hits", [])
        + product.get("organic_hits", [])
    )
    if hits:
        return hits

    return [
        {
            "substance": substance["name"],
            "category": substance["category"],
            "restriction": None,
            "rejectionCase": None,
            "organicRestriction": None,
        }
        for substance in product.get("substances", [])
    ]


def get_demo_risk_match(fertilizer_name: str, crop_name: str):
    product = DEMO_PRODUCTS.get(fertilizer_name)
    if not product:
        return None

    return {
        "fertilizer": fertilizer_name,
        "crop": crop_name,
        "substanceFindings": demo_substance_findings(product),
        "riskLevel": product.get("risk_level", "Unclear"),
        "rejectionHits": product.get("rejection_hits", []),
        "regulatoryHits": product.get("regulatory_hits", []),
        "organicHits": product.get("organic_hits", []),
    }


def get_risk_match(fertilizer_name: str, crop_name: str):
    if DEMO_MODE:
        return get_demo_risk_match(fertilizer_name, crop_name)

    with driver.session() as session:
        rows = session.execute_read(
            run_query, RISK_MATCH_QUERY,
            fertilizerName=fertilizer_name, cropName=crop_name
        )
        return rows[0] if rows else None


def get_explanation_path(fertilizer_name: str):
    if DEMO_MODE:
        product = DEMO_PRODUCTS.get(fertilizer_name)
        if not product:
            return []

        evidence = demo_substance_findings(product)
        first_hit = evidence[0] if evidence else {}
        target = (
            first_hit.get("restriction")
            or first_hit.get("rejectionCase")
            or first_hit.get("organicRestriction")
            or {"name": "No restriction found"}
        )
        return [
            {
                "pathNodes": [
                    {"labels": ["Fertilizer"], "props": {"name": fertilizer_name, "brand": product.get("brand")}},
                    {
                        "labels": ["Substance"],
                        "props": {
                            "name": first_hit.get("substance"),
                            "category": first_hit.get("category"),
                        },
                    },
                    {"labels": ["Evidence"], "props": target},
                ],
                "pathRels": [
                    {"type": "CONTAINS", "props": {}},
                    {"type": "SUPPORTED_BY", "props": {}},
                ],
            }
        ]

    with driver.session() as session:
        return session.execute_read(
            run_query, EXPLANATION_PATH_QUERY,
            fertilizerName=fertilizer_name
        )


def get_alternative(fertilizer_name: str, crop_name: str):
    if DEMO_MODE:
        product = DEMO_PRODUCTS.get(fertilizer_name)
        alternative = product.get("alternative") if product else None
        return {"alternativeProduct": alternative} if alternative else None

    with driver.session() as session:
        rows = session.execute_read(
            run_query, ALTERNATIVE_QUERY,
            fertilizerName=fertilizer_name, cropName=crop_name
        )
        return rows[0] if rows else None


def generate_demo_explanation(fertilizer: str, crop: str, risk_level: str, evidence_path: list) -> str:
    if risk_level == "Safe":
        return (
            f"The current dataset does not show an EU restriction or Kenyan rejection case "
            f"for {fertilizer} on {crop}. Keep the label and batch record with your farm "
            f"notes, and follow the label rate. Re-check if the supplier or formulation changes."
        )

    if risk_level == "Risky":
        evidence = evidence_path[0]["pathNodes"][-1]["props"] if evidence_path else {}
        code = evidence.get("regulationCode") or evidence.get("id") or "the compliance evidence"
        return (
            f"{fertilizer} is flagged as Risky for {crop} in the current dataset. "
            f"The evidence links it to {code}, which means it can put export eligibility at risk. "
            f"Do not apply it to export-bound {crop}; use the suggested alternative or ask an agronomist."
        )

    return (
        f"No matching substance, regulation, or rejection-case data was found for {fertilizer} "
        f"on {crop}. This does not prove it is safe. Treat it as Unclear and send it for expert review."
    )


def generate_grounded_explanation(fertilizer: str, crop: str, risk_level: str, evidence_path: list) -> str:
    if DEMO_MODE:
        return generate_demo_explanation(fertilizer, crop, risk_level, evidence_path)

    if not evidence_path:
        return (
            f"No matching substance, regulation, or rejection-case data was found "
            f"for {fertilizer} in our current dataset. This does not mean it is safe — "
            f"it means we don't have data yet. Treat as Unclear and seek expert review."
        )

    system_prompt = (
        "You are explaining fertilizer export-compliance risk to a smallholder Kenyan farmer "
        "who may have limited English literacy. Rules:\n"
        "1. Only state facts present in the JSON evidence provided below.\n"
        "2. Never invent a regulation, limit, or rejection case not in the evidence.\n"
        "3. Output ONLY the explanation itself — no preamble like 'Here are some sentences', "
        "no headers, no meta-commentary about the task.\n"
        "4. Write 3-4 short plain-language sentences. No jargon, no legal codes unless naming them briefly.\n"
        "5. End with one clear, concrete next step."
    )

    user_prompt = (
        f"Fertilizer: {fertilizer}\nCrop: {crop}\nRisk level: {risk_level}\n\n"
        f"Evidence (graph path from database, the ONLY facts you may use):\n"
        f"{json.dumps(evidence_path, indent=2, default=str)}"
    )

    try:
        response = llm_client.chat.completions.create(
            model=FEATHERLESS_MODEL,
            max_tokens=300,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        text = (response.choices[0].message.content or "").strip()
    except (APIError, APIConnectionError, AttributeError, IndexError) as e:
        logger.warning(f"Featherless explanation unavailable; using fallback explanation: {e}")
        return generate_demo_explanation(fertilizer, crop, risk_level, evidence_path)

    if not text:
        logger.warning("Featherless explanation returned empty content; using fallback explanation.")
        return generate_demo_explanation(fertilizer, crop, risk_level, evidence_path)

    for prefix in ["Here are 3-4 short plain-language sentences", "Here is", "Here's"]:
        if text.lower().startswith(prefix.lower()):
            text = text.split(":", 1)[-1].strip() if ":" in text[:120] else text
            break

    return text


@app.post("/check", response_model=ResultCard)
@limiter.limit("10/minute")
def check_fertilizer(request: Request, req: CheckRequest):
    try:
        resolved_name, matched_via = resolve_fertilizer_name(req.fertilizer_name)
        resolved_crop = resolve_crop_name(req.crop_name)
    except (ServiceUnavailable, Neo4jError) as e:
        logger.error(f"Neo4j error during name resolution: {e}")
        raise HTTPException(status_code=503, detail="Database temporarily unavailable. Please retry.")

    cache_key = f"{resolved_name}::{resolved_crop}"
    cached = cache_get(cache_key)
    if cached:
        cached["matched_via"] = matched_via
        if cached.get("risk_level") == "Risky" and not cached.get("alternative_product"):
            cached["alternative_product"] = DEMO_PRODUCTS.get(resolved_name, {}).get("alternative")
        return ResultCard(**cached)

    try:
        match = get_risk_match(resolved_name, resolved_crop)
    except (ServiceUnavailable, Neo4jError) as e:
        logger.error(f"Neo4j error during risk match: {e}")
        raise HTTPException(status_code=503, detail="Database temporarily unavailable. Please retry.")

    if not match or not match.get("fertilizer"):
        raise HTTPException(
            status_code=404,
            detail=f"'{req.fertilizer_name}' not found in dataset, even after fuzzy matching. "
                    f"Routed to manual/expert review — use the /escalate endpoint."
        )

    risk_level = match["riskLevel"]

    try:
        evidence_path = get_explanation_path(resolved_name)
    except (ServiceUnavailable, Neo4jError) as e:
        logger.error(f"Neo4j error during explanation path: {e}")
        evidence_path = []

    explanation = generate_grounded_explanation(resolved_name, resolved_crop, risk_level, evidence_path)

    next_step_map = {
        "Safe": "Proceed with application as planned.",
        "Risky": "Avoid this product for export-bound crops. See suggested alternative below, or consult an agronomist.",
        "Unclear": "Do not assume safety. Escalate to an agronomist or cooperative compliance officer before applying.",
    }

    alt = None
    if risk_level == "Risky":
        try:
            alt_result = get_alternative(resolved_name, resolved_crop)
            if alt_result:
                alt = alt_result.get("alternativeProduct")
        except (ServiceUnavailable, Neo4jError) as e:
            logger.warning(f"Neo4j error during alternative lookup (non-fatal): {e}")
        if not alt:
            alt = DEMO_PRODUCTS.get(resolved_name, {}).get("alternative")

    raw_evidence = {
        "regulatoryHits": match.get("regulatoryHits", []),
        "rejectionHits": match.get("rejectionHits", []),
        "organicHits": match.get("organicHits", []),
    }
    safe_evidence = json.loads(json.dumps(raw_evidence, default=str))

    result = {
        "fertilizer": match["fertilizer"],
        "crop": match["crop"] or resolved_crop,
        "risk_level": risk_level,
        "explanation": explanation,
        "next_step": next_step_map.get(risk_level, "Seek expert review."),
        "alternative_product": alt,
        "evidence": safe_evidence,
        "matched_via": matched_via,
    }

    cache_set(cache_key, dict(result))
    return ResultCard(**result)


@app.post("/escalate")
@limiter.limit("5/minute")
def escalate_to_expert(request: Request, req: EscalateRequest):
    logger.info(
        f"ESCALATION REQUEST | fertilizer={req.fertilizer_name} | crop={req.crop_name} "
        f"| contact={req.farmer_contact} | notes={req.notes}"
    )
    return {
        "status": "received",
        "message": "Your request has been logged for expert review. "
                    "Live reviewer routing is not yet active in this prototype."
    }
@app.get("/")
def root():
    return {
        "service": "SmartExports API",
        "version": "0.1.0",
        "description": "AI-powered fertilizer EU compliance risk checker for Kenyan smallholder farmers",
        "docs": "/docs",
        "endpoints": {
            "check": "POST /check",
            "extract_label": "POST /extract-label",
            "escalate": "POST /escalate",
            "health": "GET /health"
        }
    }


@app.get("/health")
def health():
    if DEMO_MODE:
        return {"status": "ok"}

    try:
        with driver.session() as session:
            session.run("RETURN 1")
    except (ServiceUnavailable, Neo4jError) as e:
        raise HTTPException(status_code=503, detail=f"Neo4j unavailable: {e}")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Label extraction (vision) — separate endpoint, frontend calls this first,
# then feeds product_name into /check. Decoupled deliberately so OCR/vision
# can be swapped or improved independently of risk-matching logic.
# ---------------------------------------------------------------------------
class ExtractLabelResponse(BaseModel):
    product_name: Optional[str] = None
    possible_ingredients: list = []
    confidence: str  # "high" | "medium" | "low"
    raw_model_output: str


def encode_image_to_data_url(image_bytes: bytes, content_type: str) -> str:
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    mime = content_type if content_type in ("image/jpeg", "image/png", "image/webp") else "image/jpeg"
    return f"data:{mime};base64,{b64}"


def compact_label_text(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


def guess_demo_product_name(filename: Optional[str]) -> str:
    compact_filename = compact_label_text(filename or "")
    for product_name in DEMO_PRODUCTS:
        if compact_label_text(product_name) in compact_filename:
            return product_name
    return "Orthene 75SP"


def extract_label_with_vision(
    image_bytes: bytes,
    content_type: str,
    filename: Optional[str] = None,
) -> ExtractLabelResponse:
    if DEMO_MODE:
        product_name = guess_demo_product_name(filename)
        substances = [
            substance["name"]
            for substance in DEMO_PRODUCTS.get(product_name, {}).get("substances", [])
        ]
        return ExtractLabelResponse(
            product_name=product_name,
            possible_ingredients=substances,
            confidence="medium",
            raw_model_output=(
                "Demo mode: vision OCR was skipped and the product was inferred "
                "from the upload filename or sample fallback."
            ),
        )

    data_url = encode_image_to_data_url(image_bytes, content_type)

    extraction_prompt = (
        "You are reading a fertilizer/pesticide product label photo, possibly blurry, "
        "handwritten, or in a language other than English. Extract:\n"
        "1. The product/brand name as printed\n"
        "2. Any active ingredient names visible (chemical names)\n"
        "3. Your confidence: 'high' if both name and ingredients are clearly legible, "
        "'medium' if partially legible, 'low' if mostly illegible or you are guessing.\n\n"
        "Respond with ONLY valid JSON, no other text, in this exact shape:\n"
        '{"product_name": "...", "possible_ingredients": ["..."], "confidence": "high|medium|low"}\n'
        "If you cannot read a product name at all, set product_name to null and confidence to 'low'."
    )

    try:
        response = llm_client.chat.completions.create(
            model=FEATHERLESS_VISION_MODEL,
            max_tokens=300,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": extraction_prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
        )
        raw_text = response.choices[0].message.content.strip()
    except (APIError, APIConnectionError) as e:
        logger.error(f"Featherless vision API error: {e}")
        raise HTTPException(
            status_code=503,
            detail="Label extraction service is temporarily unavailable. Please retry or enter the product name manually."
        )

    # Defensive parsing — vision models sometimes wrap JSON in markdown fences
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        parsed = json.loads(cleaned)
        product_name = parsed.get("product_name")
        ingredients = parsed.get("possible_ingredients", [])
        confidence = parsed.get("confidence", "low")
        if confidence not in ("high", "medium", "low"):
            confidence = "low"
    except (json.JSONDecodeError, AttributeError):
        logger.warning(f"Could not parse vision model output as JSON: {raw_text[:200]}")
        product_name = None
        ingredients = []
        confidence = "low"

    return ExtractLabelResponse(
        product_name=product_name,
        possible_ingredients=ingredients if isinstance(ingredients, list) else [],
        confidence=confidence,
        raw_model_output=raw_text,
    )


@app.post("/extract-label", response_model=ExtractLabelResponse)
@limiter.limit("10/minute")
async def extract_label(request: Request, file: UploadFile = File(...)):
    if file.content_type not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Please upload JPEG, PNG, or WEBP."
        )

    image_bytes = await file.read()
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image too large. Max 20MB.")

    return extract_label_with_vision(image_bytes, file.content_type, file.filename)
