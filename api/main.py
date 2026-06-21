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
Env vars required: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, FEATHERLESS_API_KEY
"""

import os
import json
import time
import logging
import difflib
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError, ServiceUnavailable
from openai import OpenAI, APIError, APIConnectionError

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("smartexports")

REQUIRED_ENV_VARS = ["NEO4J_PASSWORD", "FEATHERLESS_API_KEY"]
missing = [v for v in REQUIRED_ENV_VARS if not os.environ.get(v)]
if missing:
    raise RuntimeError(
        f"Missing required environment variable(s): {', '.join(missing)}. "
        f"Copy api/.env.example to api/.env and fill in real values."
    )

NEO4J_URI = os.environ.get("NEO4J_URI", "neo4j://127.0.0.1:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD")
FEATHERLESS_MODEL = os.environ.get("FEATHERLESS_MODEL", "meta-llama/Meta-Llama-3.1-8B-Instruct")
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173").split(",")

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

llm_client = OpenAI(
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
    with driver.session() as session:
        rows = session.execute_read(
            run_query, "MATCH (f:Fertilizer) RETURN f.name AS name"
        )
        return [r["name"] for r in rows]


def resolve_fertilizer_name(fertilizer_name: str) -> tuple:
    all_names = get_all_fertilizer_names()
    if fertilizer_name in all_names:
        return fertilizer_name, "exact"

    close = difflib.get_close_matches(fertilizer_name, all_names, n=1, cutoff=0.6)
    if close:
        return close[0], f"fuzzy:{fertilizer_name}"

    return fertilizer_name, "exact"


def get_risk_match(fertilizer_name: str, crop_name: str):
    with driver.session() as session:
        rows = session.execute_read(
            run_query, RISK_MATCH_QUERY,
            fertilizerName=fertilizer_name, cropName=crop_name
        )
        return rows[0] if rows else None


def get_explanation_path(fertilizer_name: str):
    with driver.session() as session:
        return session.execute_read(
            run_query, EXPLANATION_PATH_QUERY,
            fertilizerName=fertilizer_name
        )


def get_alternative(fertilizer_name: str, crop_name: str):
    with driver.session() as session:
        rows = session.execute_read(
            run_query, ALTERNATIVE_QUERY,
            fertilizerName=fertilizer_name, cropName=crop_name
        )
        return rows[0] if rows else None


def generate_grounded_explanation(fertilizer: str, crop: str, risk_level: str, evidence_path: list) -> str:
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
        text = response.choices[0].message.content.strip()
    except (APIError, APIConnectionError) as e:
        logger.error(f"Featherless API error: {e}")
        raise HTTPException(
            status_code=503,
            detail="Explanation service is temporarily unavailable. Risk level is still valid — please retry shortly."
        )

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
    except (ServiceUnavailable, Neo4jError) as e:
        logger.error(f"Neo4j error during name resolution: {e}")
        raise HTTPException(status_code=503, detail="Database temporarily unavailable. Please retry.")

    cache_key = f"{resolved_name}::{req.crop_name}"
    cached = cache_get(cache_key)
    if cached:
        cached["matched_via"] = matched_via
        return ResultCard(**cached)

    try:
        match = get_risk_match(resolved_name, req.crop_name)
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

    explanation = generate_grounded_explanation(resolved_name, req.crop_name, risk_level, evidence_path)

    next_step_map = {
        "Safe": "Proceed with application as planned.",
        "Risky": "Avoid this product for export-bound crops. See suggested alternative below, or consult an agronomist.",
        "Unclear": "Do not assume safety. Escalate to an agronomist or cooperative compliance officer before applying.",
    }

    alt = None
    if risk_level == "Risky":
        try:
            alt_result = get_alternative(resolved_name, req.crop_name)
            if alt_result:
                alt = alt_result.get("alternativeProduct")
        except (ServiceUnavailable, Neo4jError) as e:
            logger.warning(f"Neo4j error during alternative lookup (non-fatal): {e}")

    raw_evidence = {
        "regulatoryHits": match.get("regulatoryHits", []),
        "rejectionHits": match.get("rejectionHits", []),
        "organicHits": match.get("organicHits", []),
    }
    safe_evidence = json.loads(json.dumps(raw_evidence, default=str))

    result = {
        "fertilizer": match["fertilizer"],
        "crop": match["crop"] or req.crop_name,
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


@app.get("/health")
def health():
    try:
        with driver.session() as session:
            session.run("RETURN 1")
    except (ServiceUnavailable, Neo4jError) as e:
        raise HTTPException(status_code=503, detail=f"Neo4j unavailable: {e}")
    return {"status": "ok"}
