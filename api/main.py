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

from ussd_handler import handle_ussd as _handle_ussd
from masumi import masumi_agent, validate_masumi_payment, make_receipt
import json
import time
import logging
import difflib
import base64
import uuid
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Optional
from dotenv import load_dotenv
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from slowapi import Limiter, _rate_limit_exceeded_handler
from openai import OpenAI, APIError, APIConnectionError
from neo4j.exceptions import Neo4jError, ServiceUnavailable
from neo4j import GraphDatabase
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
import sys
import os

# Ensure api/ directory is in path so masumi can be found
# regardless of whether this file is run directly or imported as api.main
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("smartexports")

REQUIRED_ENV_VARS = ["NEO4J_PASSWORD", "FEATHERLESS_API_KEY"]

# Email config
SMTP_EMAIL = os.environ.get("SMTP_EMAIL", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")

# Africa's Talking config
AT_USERNAME = os.environ.get("AT_USERNAME", "sandbox")
AT_API_KEY = os.environ.get("AT_API_KEY", "")
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
FEATHERLESS_MODEL = os.getenv(
    "FEATHERLESS_MODEL", "").strip() or "Qwen/Qwen2.5-7B-Instruct"
FEATHERLESS_VISION_MODEL = os.environ.get(
    "FEATHERLESS_VISION_MODEL", "google/gemma-3-27b-it")
SMTP_EMAIL = os.environ.get("SMTP_EMAIL", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
EXPERT_EMAIL = os.environ.get("EXPERT_EMAIL", "")
EXPLANATION_PROVIDER = os.environ.get(
    "EXPLANATION_PROVIDER", "featherless").lower()
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
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
    CORS_ORIGINS.extend([o.strip()
                        for o in env_origins.split(",") if o.strip()])

# Remove duplicates
CORS_ORIGINS = list(set(CORS_ORIGINS))

driver = None if DEMO_MODE else GraphDatabase.driver(
    NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

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

# ── Email helper ───────────────────────────────────────────────────────────[...]


def send_expert_email(expert_email: str, expert_name: str, farmer_name: str,
                      farmer_phone: str, farmer_county: str, fertilizer: str,
                      crop: str, risk_level: str, explanation: str, escalation_id: str):
    if not SMTP_EMAIL or not SMTP_PASSWORD:
        logger.warning("SMTP credentials not set — skipping email.")
        return False
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"[SmartExports] Expert Review Request — {fertilizer} / {crop}"
        msg["From"] = SMTP_EMAIL
        msg["To"] = expert_email

        body = f"""
Dear {expert_name},

A farmer needs your expert advice on an EU compliance issue.

ESCALATION ID: {escalation_id}

FARMER DETAILS:
  Name:    {farmer_name or "Not provided"}
  Phone:   {farmer_phone or "Not provided"}
  County:  {farmer_county or "Not provided"}

PRODUCT DETAILS:
  Fertilizer: {fertilizer}
  Crop:       {crop}
  Risk Level: {risk_level}

SYSTEM EXPLANATION:
{explanation}

Please contact the farmer directly via phone or reply to this email with your advice.
Your response will be logged in the SmartExports system.

Thank you,
SmartExports Team
        """.strip()

        msg.attach(MIMEText(body, "plain"))

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(SMTP_EMAIL, SMTP_PASSWORD)
            server.sendmail(SMTP_EMAIL, expert_email, msg.as_string())

        logger.info(
            f"Expert email sent to {expert_email} for escalation {escalation_id}")
        return True
    except Exception as e:
        logger.error(f"Failed to send expert email: {e}")
        return False


# ── SMS helper ──────────────────────────────────────────────────────────�[...]

def send_farmer_sms(phone: str, farmer_name: str, expert_name: str,
                    organization: str, escalation_id: str):
    if not AT_API_KEY:
        logger.warning("Africa's Talking API key not set — skipping SMS.")
        return False
    try:
        import africastalking
        africastalking.initialize(AT_USERNAME, AT_API_KEY)
        sms = africastalking.SMS
        message = (
            f"SmartExports: Hi {farmer_name or 'Farmer'}, your request ({escalation_id[:8]}) "
            f"has been matched to {expert_name} from {organization}. "
            f"They will contact you within 24hrs."
        )
        response = sms.send(message, [phone])
        logger.info(f"SMS sent to {phone}: {response}")
        return True
    except Exception as e:
        logger.error(f"Failed to send SMS: {e}")
        return False


# ── Expert matching ────────────────────────────────────────────────────────

EXPERT_MATCH_QUERY = ""


def load_expert_match_query():
    global EXPERT_MATCH_QUERY
    path = os.path.join(CYPHER_DIR, "09_expert_match.cypher")
    if os.path.exists(path):
        EXPERT_MATCH_QUERY = open(path).read()


def match_expert(county: str, crop: str, substances: list):
    if not EXPERT_MATCH_QUERY:
        return None
    try:
        with driver.session() as session:
            rows = session.execute_read(
                run_query,
                EXPERT_MATCH_QUERY,
                county=county,
                crop=crop,
                substances=substances,
            )
            return rows[0] if rows else None
    except Exception as e:
        logger.error(f"Expert matching error: {e}")
        return None


# ── Store escalation in Neo4j ──────────────────────────────────────────────

def store_escalation(escalation_id: str, farmer_name: str, farmer_phone: str,
                     farmer_county: str, fertilizer: str, crop: str,
                     risk_level: str, expert_id: Optional[str]):
    query = """
    MERGE (esc:Escalation {id: $id})
    SET esc.farmer_name    = $farmer_name,
        esc.farmer_phone   = $farmer_phone,
        esc.farmer_county  = $farmer_county,
        esc.fertilizer     = $fertilizer,
        esc.crop           = $crop,
        esc.risk_level     = $risk_level,
        esc.status         = $status,
        esc.created_at     = $created_at
    WITH esc
    MATCH (f:Fertilizer {name: $fertilizer})
    MERGE (esc)-[:ABOUT_FERTILIZER]->(f)
    WITH esc
    OPTIONAL MATCH (co:County {name: $farmer_county})
    FOREACH (_ IN CASE WHEN co IS NOT NULL THEN [1] ELSE [] END |
        MERGE (esc)-[:IN_COUNTY]->(co)
    )
    WITH esc
    OPTIONAL MATCH (e:Expert {id: $expert_id})
    FOREACH (_ IN CASE WHEN e IS NOT NULL THEN [1] ELSE [] END |
        MERGE (esc)-[:MATCHED_TO]->(e)
    )
    RETURN esc.id AS id
    """
    try:
        with driver.session() as session:
            session.execute_write(
                run_query,
                query,
                id=escalation_id,
                farmer_name=farmer_name or "",
                farmer_phone=farmer_phone or "",
                farmer_county=farmer_county or "",
                fertilizer=fertilizer,
                crop=crop,
                risk_level=risk_level or "Unclear",
                status="pending",
                created_at=int(time.time()),
                expert_id=expert_id or "",
            )
        logger.info(f"Escalation {escalation_id} stored in Neo4j")
    except Exception as e:
        logger.error(f"Failed to store escalation: {e}")


CYPHER_DIR = os.path.join(os.path.dirname(__file__), "..", "cypher")
RISK_MATCH_QUERY = open(os.path.join(
    CYPHER_DIR, "03_risk_match_query.cypher")).read()
EXPLANATION_PATH_QUERY = open(os.path.join(
    CYPHER_DIR, "04_explanation_path.cypher")).read()
ALTERNATIVE_QUERY = open(os.path.join(
    CYPHER_DIR, "06_alternative_suggestion.cypher")).read()

# Load expert match query
load_expert_match_query()


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
    farmer_name: Optional[str] = None
    farmer_contact: Optional[str] = None
    farmer_county: Optional[str] = None
    risk_level: Optional[str] = None
    explanation: Optional[str] = None
    substances: Optional[list] = []
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

    close = difflib.get_close_matches(
        normalized_input, list(normalized_map.keys()), n=1, cutoff=0.6)
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

    close = difflib.get_close_matches(normalized_input, list(
        normalized_map.keys()), n=1, cutoff=0.75)
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
                    {"labels": ["Fertilizer"], "props": {
                        "name": fertilizer_name, "brand": product.get("brand")}},
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
        code = evidence.get("regulationCode") or evidence.get(
            "id") or "the compliance evidence"
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
        if EXPLANATION_PROVIDER == "anthropic":
            from anthropic import Anthropic
            anthropic_client = Anthropic(
                api_key=os.environ.get("ANTHROPIC_API_KEY"))
            msg = anthropic_client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=300,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
            text = "".join(
                b.text for b in msg.content if getattr(b, "type", None) == "text"
            ).strip()
        else:
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
        logger.warning(
            f"Explanation provider unavailable; using fallback explanation: {e}")
        return generate_demo_explanation(fertilizer, crop, risk_level, evidence_path)

    if not text:
        logger.warning(
            "Explanation provider returned empty content; using fallback explanation.")
        return generate_demo_explanation(fertilizer, crop, risk_level, evidence_path)

    for prefix in ["Here are 3-4 short plain-language sentences", "Here is", "Here's"]:
        if text.lower().startswith(prefix.lower()):
            text = text.split(
                ":", 1)[-1].strip() if ":" in text[:120] else text
            break

    return text


@app.post("/check", response_model=ResultCard)
@limiter.limit("10/minute")
def check_fertilizer(request: Request, req: CheckRequest):
    try:
        resolved_name, matched_via = resolve_fertilizer_name(
            req.fertilizer_name)
        resolved_crop = resolve_crop_name(req.crop_name)
    except (ServiceUnavailable, Neo4jError) as e:
        logger.error(f"Neo4j error during name resolution: {e}")
        raise HTTPException(
            status_code=503, detail="Database temporarily unavailable. Please retry.")

    cache_key = f"{resolved_name}::{resolved_crop}"
    cached = cache_get(cache_key)
    if cached:
        cached["matched_via"] = matched_via
        if cached.get("risk_level") == "Risky" and not cached.get("alternative_product"):
            cached["alternative_product"] = DEMO_PRODUCTS.get(
                resolved_name, {}).get("alternative")
        return ResultCard(**cached)

    try:
        match = get_risk_match(resolved_name, resolved_crop)
    except (ServiceUnavailable, Neo4jError) as e:
        logger.error(f"Neo4j error during risk match: {e}")
        raise HTTPException(
            status_code=503, detail="Database temporarily unavailable. Please retry.")

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

    explanation = generate_grounded_explanation(
        resolved_name, resolved_crop, risk_level, evidence_path)

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
            logger.warning(
                f"Neo4j error during alternative lookup (non-fatal): {e}")
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


def _send_escalation_email(req: EscalateRequest, substance_info: list):
    """
    Sends escalation notification to expert pool inbox.
    Includes all farmer context so coordinator can route to right expert.
    """
    if not SMTP_EMAIL or not SMTP_PASSWORD or not EXPERT_EMAIL:
        logger.warning(
            "Email not configured — escalation logged but not emailed.")
        return

    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    substance_lines = ""
    if substance_info:
        for s in substance_info:
            substance_lines += (
                f"\n  - {s.get('substance', 'Unknown')} "
                f"(category: {s.get('category', 'unknown')}, "
                f"evidence degree: {s.get('evidence', 0)})"
            )
    else:
        substance_lines = "\n  - Not found in database (reason for escalation)"

    email_body = f"""
SmartExports — Expert Review Request
=====================================

FARMER REQUEST DETAILS
----------------------
Fertilizer:     {req.fertilizer_name}
Crop:           {req.crop_name}
Contact:        {req.farmer_contact or 'Not provided'}
Notes:          {req.notes or 'None'}
Location:       {req.location or 'Not provided'}

SUBSTANCES IN THIS PRODUCT (from compliance graph)
---------------------------------------------------
{substance_lines}

ROUTING GUIDANCE
----------------
Match this request to an expert with:
- Crop knowledge: {req.crop_name}
- Input type knowledge: {', '.join(set(s.get('category', '') for s in substance_info)) if substance_info else 'Unknown'}

This is an automated notification from SmartExports.
The farmer will be contacted at: {req.farmer_contact or 'No contact provided'}
    """

    msg = MIMEMultipart()
    msg["From"] = SMTP_EMAIL
    msg["To"] = EXPERT_EMAIL
    msg["Subject"] = f"[SmartExports] Expert Review: {req.fertilizer_name} + {req.crop_name}"
    msg.attach(MIMEText(email_body, "plain"))

    try:
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.ehlo()
            server.starttls()
            server.login(SMTP_EMAIL, SMTP_PASSWORD)
            server.sendmail(SMTP_EMAIL, EXPERT_EMAIL, msg.as_string())
        logger.info(f"Escalation email sent to {EXPERT_EMAIL}")
    except Exception as e:
        logger.error(f"Failed to send escalation email: {e}")


@app.post("/escalate")
@limiter.limit("5/minute")
def escalate_to_expert(request: Request, req: EscalateRequest):
    escalation_id = f"ESC-{uuid.uuid4().hex[:8].upper()}"

    logger.info(
        f"ESCALATION | id={escalation_id} | fertilizer={req.fertilizer_name} "
        f"| crop={req.crop_name} | county={req.farmer_county} "
        f"| contact={req.farmer_contact} | notes={req.notes}"
    )

    # 1. Match expert
    expert = match_expert(
        county=req.farmer_county or "",
        crop=req.crop_name,
        substances=req.substances or [],
    )

    expert_id = expert["expertId"] if expert else None
    expert_name = expert["expertName"] if expert else "Our team"
    expert_email = expert["expertEmail"] if expert else None
    organization = expert["organization"] if expert else "SmartExports"

    # 2. Store escalation in Neo4j
    store_escalation(
        escalation_id=escalation_id,
        farmer_name=req.farmer_name or "",
        farmer_phone=req.farmer_contact or "",
        farmer_county=req.farmer_county or "",
        fertilizer=req.fertilizer_name,
        crop=req.crop_name,
        risk_level=req.risk_level or "Unclear",
        expert_id=expert_id,
    )

    # 3. Email the expert (in background thread so endpoint never blocks)
    import threading
    if expert_email:
        threading.Thread(
            target=send_expert_email,
            args=(expert_email, expert_name, req.farmer_name or "",
                  req.farmer_contact or "", req.farmer_county or "",
                  req.fertilizer_name, req.crop_name,
                  req.risk_level or "Unclear",
                  req.explanation or "No explanation available.",
                  escalation_id),
            daemon=True,
        ).start()

    # 4. SMS the farmer (in background thread)
    if req.farmer_contact:
        threading.Thread(
            target=send_farmer_sms,
            args=(req.farmer_contact, req.farmer_name or "",
                  expert_name, organization, escalation_id),
            daemon=True,
        ).start()

    return {
        "status": "received",
        "escalation_id": escalation_id,
        "expert_matched": expert is not None,
        "expert_name": expert_name,
        "expert_organization": organization,
        "message": (
            f"Your request {escalation_id} has been logged. "
            f"{expert_name} from {organization} will contact you within 24 hours."
            if expert else
            "Your request has been logged. Our team will review and connect you to the right expert shortly."
        ),
    }


@app.get("/crops")
def get_crops(q: Optional[str] = None):
    """
    Returns all crops in the compliance graph.
    Optional ?q= parameter for fuzzy search.
    Powers the frontend searchable crop input.
    If a crop is not in the list, the frontend should still
    allow free-text entry — /check handles unknown crops
    gracefully with an Unclear verdict.
    """
    with driver.session() as session:
        rows = session.execute_read(
            run_query, "MATCH (c:Crop) RETURN c.name AS name ORDER BY c.name"
        )
    all_crops = [r["name"] for r in rows]

    if q:
        normalized_q = normalize_name(q)
        # Exact prefix match first
        prefix_matches = [c for c in all_crops if normalize_name(
            c).startswith(normalized_q)]
        # Then fuzzy matches
        fuzzy_matches = difflib.get_close_matches(
            normalized_q, [normalize_name(c) for c in all_crops], n=5, cutoff=0.4)
        fuzzy_original = [
            c for c in all_crops if normalize_name(c) in fuzzy_matches]
        # Combine, deduplicate, preserve order
        combined = prefix_matches + \
            [c for c in fuzzy_original if c not in prefix_matches]
        return {
            "crops": combined,
            "total": len(combined),
            "query": q,
            "note": "If your crop is not listed, enter it manually — the system will still check the fertilizer and flag Unclear if crop-specific data is unavailable."
        }

    return {
        "crops": all_crops,
        "total": len(all_crops),
        "query": None,
        "note": "If your crop is not listed, enter it manually — the system will still check the fertilizer and flag Unclear if crop-specific data is unavailable."
    }


# ---------------------------------------------------------------------------
# USSD Handler — Africa's Talking integration
# Callback URL to set in AT dashboard:
# https://smartexports-api.onrender.com/ussd
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))

AT_USERNAME = os.environ.get("AT_USERNAME", "sandbox")
AT_API_KEY = os.environ.get("AT_API_KEY")


def _ussd_risk_check(fertilizer_name: str, crop_name: str):
    """Wrapper so USSD handler can call Neo4j without knowing internals."""
    try:
        resolved, _ = resolve_fertilizer_name(fertilizer_name)
        match = get_risk_match(resolved, crop_name)
        if not match or not match.get("fertilizer"):
            return None
        alt = None
        if match.get("riskLevel") == "Risky":
            alt_result = get_alternative(resolved, crop_name)
            if alt_result:
                alt = alt_result.get("alternativeProduct")
        return {
            "fertilizer": match.get("fertilizer"),
            "risk_level": match.get("riskLevel"),
            "alternative_product": alt,
        }
    except Exception as e:
        logger.error(f"USSD risk check error: {e}")
        return None


@app.post("/ussd")
async def ussd_callback(request: Request):
    """
    Africa's Talking USSD callback endpoint.
    AT sends form data: sessionId, phoneNumber, networkCode, text
    We return plain text starting with CON (continue) or END (terminate).
    """
    form = await request.form()
    session_id = form.get("sessionId", "")
    phone = form.get("phoneNumber", "")
    text = form.get("text", "")

    logger.info(f"USSD session={session_id} phone={phone} text={text!r}")

    response_text = _handle_ussd(session_id, phone, text, _ussd_risk_check)

    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(content=response_text)


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
    mime = content_type if content_type in (
        "image/jpeg", "image/png", "image/webp") else "image/jpeg"
    return f"data:{mime};base64,{b64}"


def compact_label_text(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


def guess_demo_product_name(filename: Optional[str]) -> str:
    compact_filename = compact_label_text(filename or "")
    for product_name in DEMO_PRODUCTS:
        if compact_label_text(product_name) in compact_filename:
            return product_name
    return "Orthene 75SP"


def extract_known_product_from_filename(filename: Optional[str]) -> Optional[str]:
    compact_filename = compact_label_text(filename or "")
    for product_name in DEMO_PRODUCTS:
        compact_product = compact_label_text(product_name)
        product_tokens = [
            compact_label_text(token)
            for token in product_name.split()
            if len(compact_label_text(token)) >= 4
        ]
        if compact_product in compact_filename or any(
            token in compact_filename for token in product_tokens
        ):
            return product_name
    return None


def fallback_extract_label_response(filename: Optional[str], reason: str) -> ExtractLabelResponse:
    product_name = extract_known_product_from_filename(filename)
    substances = (
        [
            substance["name"]
            for substance in DEMO_PRODUCTS.get(product_name, {}).get("substances", [])
        ]
        if product_name
        else []
    )
    return ExtractLabelResponse(
        product_name=product_name,
        possible_ingredients=substances,
        confidence="medium" if product_name else "low",
        raw_model_output=reason,
    )


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
        return fallback_extract_label_response(
            filename,
            "Vision service unavailable; used filename fallback for known demo labels.",
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
        logger.warning(
            f"Could not parse vision model output as JSON: {raw_text[:200]}")
        product_name = None
        ingredients = []
        confidence = "low"

    return ExtractLabelResponse(
        product_name=product_name,
        possible_ingredients=ingredients if isinstance(
            ingredients, list) else [],
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
        raise HTTPException(
            status_code=400, detail="Image too large. Max 20MB.")

    return extract_label_with_vision(image_bytes, file.content_type, file.filename)


# ── Masumi AI Agent endpoints ─────────────────────────────────────────────────

class MasumiCheckRequest(BaseModel):
    fertilizer_name: str
    crop_name: str
    masumi_payment_token: Optional[str] = None


class MasumiCheckResponse(BaseModel):
    fertilizer: str
    crop: str
    risk_level: str
    explanation: str
    next_step: str
    alternative_product: Optional[str] = None
    evidence: dict
    matched_via: str
    masumi_receipt: dict


@app.post("/masumi/check", response_model=MasumiCheckResponse)
@limiter.limit("10/minute")
def masumi_check(request: Request, req: MasumiCheckRequest):
    """
    Masumi-protocol compliance check.

    Accepts an optional masumi_payment_token (Cardano tx_hash).
    In sandbox mode any token (or none) is accepted and the receipt is
    marked sandbox=True. In production mode the token must be a valid
    confirmed Cardano transaction sending >= 1 ADA to the agent wallet.

    Returns the same ResultCard as /check plus a masumi_receipt object.
    """
    # 1. Validate payment token
    validation = validate_masumi_payment(req.masumi_payment_token)
    if not validation["valid"]:
        raise HTTPException(
            status_code=402,
            detail=f"Payment required. {validation.get('reason', 'invalid_token')}. "
            f"See /masumi/agent-card for pricing and wallet address."
        )

    # 2. Run the same compliance check logic as /check
    try:
        resolved_name, matched_via = resolve_fertilizer_name(
            req.fertilizer_name)
        resolved_crop = resolve_crop_name(req.crop_name)
    except (ServiceUnavailable, Neo4jError) as e:
        logger.error(f"Masumi check — Neo4j error during name resolution: {e}")
        raise HTTPException(
            status_code=503, detail="Database temporarily unavailable. Please retry.")

    cache_key = f"{resolved_name}::{resolved_crop}"
    cached = cache_get(cache_key)

    if cached:
        cached["matched_via"] = matched_via
        if cached.get("risk_level") == "Risky" and not cached.get("alternative_product"):
            cached["alternative_product"] = DEMO_PRODUCTS.get(
                resolved_name, {}).get("alternative")
        result_data = dict(cached)
    else:
        try:
            match = get_risk_match(resolved_name, resolved_crop)
        except (ServiceUnavailable, Neo4jError) as e:
            logger.error(f"Masumi check — Neo4j error during risk match: {e}")
            raise HTTPException(
                status_code=503, detail="Database temporarily unavailable. Please retry.")

        if not match or not match.get("fertilizer"):
            raise HTTPException(
                status_code=404,
                detail=f"'{req.fertilizer_name}' not found. Use /escalate for expert review."
            )

        risk_level = match["riskLevel"]

        try:
            evidence_path = get_explanation_path(resolved_name)
        except (ServiceUnavailable, Neo4jError):
            evidence_path = []

        explanation = generate_grounded_explanation(
            resolved_name, resolved_crop, risk_level, evidence_path)

        next_step_map = {
            "Safe": "Proceed with application as planned.",
            "Risky": "Avoid this product for export-bound crops. See suggested alternative below, or consult an agronomist.",
            "Unclear": "Do not assume safety. Escalate to an agronomist before applying.",
        }

        alt = None
        if risk_level == "Risky":
            try:
                alt_result = get_alternative(resolved_name, resolved_crop)
                if alt_result:
                    alt = alt_result.get("alternativeProduct")
            except (ServiceUnavailable, Neo4jError):
                pass
            if not alt:
                alt = DEMO_PRODUCTS.get(resolved_name, {}).get("alternative")

        raw_evidence = {
            "regulatoryHits": match.get("regulatoryHits", []),
            "rejectionHits": match.get("rejectionHits", []),
            "organicHits": match.get("organicHits", []),
        }
        safe_evidence = json.loads(json.dumps(raw_evidence, default=str))

        result_data = {
            "fertilizer": match["fertilizer"],
            "crop": match["crop"] or resolved_crop,
            "risk_level": risk_level,
            "explanation": explanation,
            "next_step": next_step_map.get(risk_level, "Seek expert review."),
            "alternative_product": alt,
            "evidence": safe_evidence,
            "matched_via": matched_via,
        }
        cache_set(cache_key, dict(result_data))

    # 3. Attach Masumi receipt
    receipt = make_receipt(
        req.masumi_payment_token,
        result_data["fertilizer"],
        result_data["crop"],
        validation,
    )
    logger.info(
        f"Masumi check | receipt={receipt['receipt_id']} | "
        f"sandbox={receipt['sandbox']} | "
        f"{result_data['fertilizer']} + {result_data['crop']} → {result_data['risk_level']}"
    )

    return MasumiCheckResponse(**result_data, masumi_receipt=receipt)


@app.get("/masumi/agent-card")
def masumi_agent_card():
    """
    Masumi registry-compatible agent card.

    Returns metadata for SmartExports as a discoverable Masumi agent:
    name, capabilities, pricing (lovelace), wallet address, endpoint URLs.
    External platforms can use this to discover and call the agent.
    """
    return masumi_agent.get_agent_card()
