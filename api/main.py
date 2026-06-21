"""
SmartExports API — end-to-end risk-check service.

Flow per request:
1. Receive fertilizer name + crop name (from OCR/manual entry on frontend)
2. Run risk-match Cypher -> get Safe/Risky/Unclear + supporting facts
3. Run explanation-path Cypher -> get the shortest evidence chain
4. Feed ONLY that retrieved evidence into the LLM prompt (GraphRAG —
   model is grounded, not allowed to invent regulatory claims)
5. Run alternative-suggestion Cypher if risk == Risky
6. Return a single result card to the frontend

Run with: uvicorn main:app --reload --port 8000
Env vars required: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, FEATHERLESS_API_KEY
"""

import os
import json
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from neo4j import GraphDatabase
from openai import OpenAI

app = FastAPI(title="SmartExports API")

NEO4J_URI = os.environ.get("NEO4J_URI", "neo4j://127.0.0.1:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD")
FEATHERLESS_MODEL = os.environ.get("FEATHERLESS_MODEL", "meta-llama/Meta-Llama-3.1-8B-Instruct")

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

# Featherless exposes an OpenAI-compatible API, so we just point the
# OpenAI client at their base_url instead of openai.com.
llm_client = OpenAI(
    api_key=os.environ.get("FEATHERLESS_API_KEY"),
    base_url="https://api.featherless.ai/v1",
)

RISK_MATCH_QUERY = open("../cypher/03_risk_match_query.cypher").read()
EXPLANATION_PATH_QUERY = open("../cypher/04_explanation_path.cypher").read()
ALTERNATIVE_QUERY = open("../cypher/06_alternative_suggestion.cypher").read()


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


def run_query(tx, query, **params):
    result = tx.run(query, **params)
    return [record.data() for record in result]


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
    """
    GraphRAG step. The model only sees the retrieved graph evidence —
    never asked to recall regulations from its own training data.
    """
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
        "3. Write 3-4 short plain-language sentences. No jargon, no legal codes unless naming them briefly.\n"
        "4. End with one clear, concrete next step."
    )

    user_prompt = (
        f"Fertilizer: {fertilizer}\nCrop: {crop}\nRisk level: {risk_level}\n\n"
        f"Evidence (graph path from database, the ONLY facts you may use):\n"
        f"{json.dumps(evidence_path, indent=2, default=str)}"
    )

    response = llm_client.chat.completions.create(
        model=FEATHERLESS_MODEL,
        max_tokens=300,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    return response.choices[0].message.content


@app.post("/check", response_model=ResultCard)
def check_fertilizer(req: CheckRequest):
    match = get_risk_match(req.fertilizer_name, req.crop_name)
    if not match or not match.get("fertilizer"):
        raise HTTPException(status_code=404, detail="Fertilizer not found in dataset. Routed to Unclear/manual review.")

    risk_level = match["riskLevel"]
    evidence_path = get_explanation_path(req.fertilizer_name)

    explanation = generate_grounded_explanation(
        req.fertilizer_name, req.crop_name, risk_level, evidence_path
    )

    next_step_map = {
        "Safe": "Proceed with application as planned.",
        "Risky": "Avoid this product for export-bound crops. See suggested alternative below, or consult an agronomist.",
        "Unclear": "Do not assume safety. Escalate to an agronomist or cooperative compliance officer before applying.",
    }

    alt = None
    if risk_level == "Risky":
        alt_result = get_alternative(req.fertilizer_name, req.crop_name)
        if alt_result:
            alt = alt_result.get("alternativeProduct")

    raw_evidence = {
        "regulatoryHits": match.get("regulatoryHits", []),
        "rejectionHits": match.get("rejectionHits", []),
        "organicHits": match.get("organicHits", []),
    }
    safe_evidence = json.loads(json.dumps(raw_evidence, default=str))

    return ResultCard(
        fertilizer=match["fertilizer"],
        crop=match["crop"] or req.crop_name,
        risk_level=risk_level,
        explanation=explanation,
        next_step=next_step_map.get(risk_level, "Seek expert review."),
        alternative_product=alt,
        evidence=safe_evidence,
    )


@app.get("/health")
def health():
    with driver.session() as session:
        session.run("RETURN 1")
    return {"status": "ok"}
