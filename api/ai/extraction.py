"""
Label extraction (vision). Lifted verbatim from main.py — vision stays on
Featherless/Qwen3-VL, the call goes through providers.vision_client. The only
structural change is that the Pydantic response model now lives in main.py and
is passed in, so this module has no FastAPI/Pydantic import.

This module returns a plain dict; main.py wraps it in ExtractLabelResponse.
Keeping it dict-based means the extraction logic stays framework-agnostic and
unit-testable without spinning up FastAPI.
"""

import json
import base64
import logging

from .prompts import EXTRACTION_PROMPT
from . import providers

logger = logging.getLogger("smartexports.ai.extraction")


def encode_image_to_data_url(image_bytes: bytes, content_type: str) -> str:
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    mime = content_type if content_type in ("image/jpeg", "image/png", "image/webp") else "image/jpeg"
    return f"data:{mime};base64,{b64}"


def extract_label(image_bytes: bytes, content_type: str) -> dict:
    """
    Returns: {product_name, possible_ingredients, confidence, raw_model_output}
    On any read/parse failure, defaults to confidence='low' rather than guessing
    — the rule from the Phase One risk section.
    """
    data_url = encode_image_to_data_url(image_bytes, content_type)

    try:
        response = providers.vision_client.chat.completions.create(
            model=providers.VISION_MODEL,
            max_tokens=300,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": EXTRACTION_PROMPT},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
        )
        raw_text = response.choices[0].message.content.strip()
    except (providers.ProviderAPIError, providers.ProviderConnectionError) as e:
        logger.error(f"Vision API error: {e}")
        from fastapi import HTTPException
        raise HTTPException(
            status_code=503,
            detail="Label extraction service is temporarily unavailable. Please retry or enter the product name manually."
        )

    # Defensive parsing — vision models sometimes wrap JSON in markdown fences.
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

    return {
        "product_name": product_name,
        "possible_ingredients": ingredients if isinstance(ingredients, list) else [],
        "confidence": confidence,
        "raw_model_output": raw_text,
    }
