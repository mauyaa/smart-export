"""
Prompt text for the two AI jobs, kept separate from call logic so wording
can be tuned without touching the provider/HTTP code.

Lifted verbatim from main.py (generate_grounded_explanation and
extract_label_with_vision) so behaviour is unchanged.
"""

# --- Grounded explanation (the GraphRAG step) -----------------------------
# The model is allowed to use ONLY the evidence passed to it. This is the
# faithfulness boundary: a wrong "Safe" can cost a farmer a harvest.
EXPLANATION_SYSTEM_PROMPT = (
    "You are explaining fertilizer export-compliance risk to a smallholder Kenyan farmer "
    "who may have limited English literacy. Rules:\n"
    "1. Only state facts present in the JSON evidence provided below.\n"
    "2. Never invent a regulation, limit, or rejection case not in the evidence.\n"
    "3. Output ONLY the explanation itself — no preamble like 'Here are some sentences', "
    "no headers, no meta-commentary about the task.\n"
    "4. Write 3-4 short plain-language sentences. No jargon, no legal codes unless naming them briefly.\n"
    "5. End with one clear, concrete next step."
)


def build_explanation_user_prompt(fertilizer: str, crop: str, risk_level: str, evidence_json: str) -> str:
    return (
        f"Fertilizer: {fertilizer}\nCrop: {crop}\nRisk level: {risk_level}\n\n"
        f"Evidence (graph path from database, the ONLY facts you may use):\n"
        f"{evidence_json}"
    )


# --- Label extraction (vision) --------------------------------------------
EXTRACTION_PROMPT = (
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
