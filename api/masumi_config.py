"""
Masumi protocol configuration for SmartExports.

Masumi is a decentralized AI agent payment and identity protocol on Cardano.
Set MASUMI_WALLET_ADDRESS and MASUMI_NETWORK in environment to use real Cardano.
Without them the layer runs in sandbox mode — same interface, no on-chain settlement.
"""

import os
import secrets

# ── Cardano / Masumi network ────────────────────────────────────────────────
MASUMI_NETWORK = os.environ.get("MASUMI_NETWORK", "cardano-preprod")
MASUMI_WALLET_ADDRESS = os.environ.get(
    "MASUMI_WALLET_ADDRESS",
    "addr_test1qz_REPLACE_WITH_REAL_WALLET",
)
MASUMI_REGISTRY_URL = os.environ.get(
    "MASUMI_REGISTRY_URL",
    "https://registry.masumi.network/api/v1",
)

# Price per compliance check in lovelace (1 ADA = 1,000,000 lovelace)
MASUMI_PRICE_LOVELACE = int(os.environ.get("MASUMI_PRICE_LOVELACE", "1000000"))

# Agent DID / identifier — deterministic from wallet or auto-generated for sandbox
MASUMI_AGENT_ID = os.environ.get(
    "MASUMI_AGENT_ID",
    f"did:masumi:smartexports:{secrets.token_hex(8)}",
)

MASUMI_SANDBOX = not bool(
    os.environ.get("MASUMI_WALLET_ADDRESS")
    and os.environ.get("MASUMI_NETWORK")
    and "REPLACE" not in os.environ.get("MASUMI_WALLET_ADDRESS", "")
)

# ── Agent card metadata (Masumi registry format) ─────────────────────────────
AGENT_CARD = {
    "name": "SmartExports Compliance Checker",
    "version": "1.0.0",
    "description": (
        "Pre-application EU compliance screening for Kenyan fertilizers. "
        "A farmer photographs or types a fertilizer label → the system checks it "
        "against EU regulations and real RASFF border rejection cases → returns "
        "Safe / Risky / Unclear in plain language with a concrete next step. "
        "Grounded in graph-RAG, never hallucinates regulatory facts."
    ),
    "capabilities": [
        "fertilizer-compliance-check",
        "eu-mrl-screening",
        "rasff-rejection-lookup",
        "graphrag-grounded",
    ],
    "input_schema": {
        "type": "object",
        "properties": {
            "fertilizer_name": {"type": "string", "description": "Brand or generic fertilizer name"},
            "crop_name": {"type": "string", "description": "Export-bound crop (e.g. French Beans, Avocado)"},
        },
        "required": ["fertilizer_name", "crop_name"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "risk_level": {"type": "string", "enum": ["Safe", "Risky", "Unclear"]},
            "explanation": {"type": "string"},
            "next_step": {"type": "string"},
            "alternative_product": {"type": ["string", "null"]},
            "evidence": {"type": "object"},
            "masumi_receipt": {"type": "object"},
        },
    },
    "pricing": {
        "per_check_lovelace": MASUMI_PRICE_LOVELACE,
        "currency": "ADA",
        "network": MASUMI_NETWORK,
        "wallet": MASUMI_WALLET_ADDRESS,
    },
    "endpoints": {
        "check": "/masumi/check",
        "agent_card": "/masumi/agent-card",
        "health": "/health",
    },
    "agent_id": MASUMI_AGENT_ID,
    "network": MASUMI_NETWORK,
    "tags": ["agriculture", "compliance", "kenya", "eu-regulations", "cardano"],
    "contact": {
        "github": "https://github.com/mauyaa/smart-export",
        "demo": "https://front-end-nu-rosy-90.vercel.app",
    },
}
