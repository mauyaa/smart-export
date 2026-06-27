"""
SmartExports AI module.

Isolates the two AI jobs (label extraction + grounded explanation) from the
FastAPI app. main.py imports from here; the route handlers stay thin.

Provider for the explanation step is config-driven (EXPLANATION_PROVIDER);
vision extraction always uses Featherless/Qwen3-VL.
"""

from .extraction import extract_label, encode_image_to_data_url
from .explanation import generate_grounded_explanation

__all__ = [
    "extract_label",
    "encode_image_to_data_url",
    "generate_grounded_explanation",
]
