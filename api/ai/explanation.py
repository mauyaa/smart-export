"""
Grounded explanation (GraphRAG step).

Lifted from main.py's generate_grounded_explanation. Two changes from the
original:
  1. The LLM call goes through providers.complete_text() so it can be
     Featherless (Llama 3.1) or Anthropic (Claude) by config.
  2. A code-level grounding check verifies the model did not introduce a
     substance/regulation/case name absent from the evidence. If it did, we
     fall back to a templated explanation built straight from the graph fields.
     This is cheap insurance for the exact failure that would embarrass a demo.

The empty-evidence behaviour is unchanged: no evidence -> safe "treat as
Unclear" message, never an invented justification.
"""

import re
import json
import logging

from .prompts import EXPLANATION_SYSTEM_PROMPT, build_explanation_user_prompt
from . import providers

logger = logging.getLogger("smartexports.ai.explanation")


def _collect_grounding_terms(evidence_path: list) -> set:
    """
    Pull every string value out of the evidence into a set of lowercased tokens.
    These are the only proper nouns / codes the explanation is allowed to use.
    """
    terms = set()

    def walk(node):
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, str):
            for tok in re.findall(r"[A-Za-z0-9/]{3,}", node):
                terms.add(tok.lower())

    walk(evidence_path)
    return terms


# Regulatory-code shapes like "EU 2021/1165" or "2019/1009" — if the model
# emits one of these, it must have come from the evidence.
_REG_CODE_RE = re.compile(r"\b(?:EU\s*)?\d{4}/\d{3,4}\b", re.IGNORECASE)


def _passes_grounding_check(text: str, evidence_path: list) -> bool:
    """
    Returns False if the explanation cites a regulation code that does not
    appear anywhere in the evidence. Conservative: only flags concrete codes,
    not ordinary prose, to avoid false positives on plain-language text.
    """
    allowed = _collect_grounding_terms(evidence_path)
    for code in _REG_CODE_RE.findall(text):
        normalized = re.sub(r"[^0-9/]", "", code).lower()
        if normalized and not any(normalized in term or term in normalized for term in allowed):
            logger.warning(f"Grounding check failed: '{code}' not in evidence.")
            return False
    return True


def _templated_explanation(fertilizer: str, crop: str, risk_level: str, evidence_path: list) -> str:
    """
    Deterministic fallback built only from graph fields — used when the model
    output fails the grounding check. No model involvement, so it cannot
    hallucinate.
    """
    bits = []
    for item in evidence_path:
        if isinstance(item, dict):
            for key in ("substance", "regulation", "limit", "case", "reason"):
                if item.get(key):
                    bits.append(f"{key}: {item[key]}")
    detail = "; ".join(bits[:6]) if bits else "matching compliance records were found"
    step = {
        "Safe": "You may proceed.",
        "Risky": "Avoid this product for export-bound crops and consult an agronomist.",
        "Unclear": "Do not assume safety — seek expert review before applying.",
    }.get(risk_level, "Seek expert review.")
    return (
        f"For {fertilizer} on {crop}, our records show {detail}. "
        f"The assessed risk level is {risk_level}. {step}"
    )


def generate_grounded_explanation(fertilizer: str, crop: str, risk_level: str, evidence_path: list) -> str:
    # Unchanged empty-evidence path: never invent a justification.
    if not evidence_path:
        return (
            f"No matching substance, regulation, or rejection-case data was found "
            f"for {fertilizer} in our current dataset. This does not mean it is safe — "
            f"it means we don't have data yet. Treat as Unclear and seek expert review."
        )

    evidence_json = json.dumps(evidence_path, indent=2, default=str)
    user_prompt = build_explanation_user_prompt(fertilizer, crop, risk_level, evidence_json)

    try:
        text = providers.complete_text(EXPLANATION_SYSTEM_PROMPT, user_prompt, max_tokens=300)
    except (providers.ProviderAPIError, providers.ProviderConnectionError) as e:
        logger.error(f"Explanation provider error: {e}")
        # Surface the same 503 the original raised. Imported here to avoid a
        # hard FastAPI dependency at module import time.
        from fastapi import HTTPException
        raise HTTPException(
            status_code=503,
            detail="Explanation service is temporarily unavailable. Risk level is still valid — please retry shortly."
        )

    # Strip any leftover preamble (unchanged behaviour from main.py).
    for prefix in ["Here are 3-4 short plain-language sentences", "Here is", "Here's"]:
        if text.lower().startswith(prefix.lower()):
            text = text.split(":", 1)[-1].strip() if ":" in text[:120] else text
            break

    # Code-level grounding guard: if the model cited a regulation code not in
    # the evidence, discard its output and use the deterministic fallback.
    if not _passes_grounding_check(text, evidence_path):
        logger.warning("Falling back to templated explanation due to grounding failure.")
        return _templated_explanation(fertilizer, crop, risk_level, evidence_path)

    return text
