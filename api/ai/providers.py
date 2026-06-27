"""
Provider switch. This is the ONLY file in the module that knows the specifics
of a particular LLM service. Everything else calls complete_text() / the vision
client and stays provider-agnostic.

Two providers:
  - "featherless"  -> OpenAI-compatible client (Qwen3-VL vision + Llama 3.1 text)
  - "anthropic"    -> Claude (text explanation only; vision stays on Featherless)

Config (env):
  EXPLANATION_PROVIDER   "featherless" (default) | "anthropic"
  FEATHERLESS_API_KEY    required
  FEATHERLESS_MODEL          text model id
  FEATHERLESS_VISION_MODEL   vision model id
  ANTHROPIC_API_KEY      required only if EXPLANATION_PROVIDER=anthropic
  ANTHROPIC_MODEL        defaults to claude-sonnet-4-6
"""

import os
import logging

from openai import OpenAI, APIError, APIConnectionError

logger = logging.getLogger("smartexports.ai.providers")

EXPLANATION_PROVIDER = os.environ.get("EXPLANATION_PROVIDER", "featherless").lower()

FEATHERLESS_MODEL = os.environ.get("FEATHERLESS_MODEL", "meta-llama/Meta-Llama-3.1-8B-Instruct")
FEATHERLESS_VISION_MODEL = os.environ.get("FEATHERLESS_VISION_MODEL", "Qwen/Qwen3-VL-8B-Instruct")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")

# Re-export the OpenAI error types so callers can catch a single, stable pair
# regardless of which provider is active.
ProviderAPIError = APIError
ProviderConnectionError = APIConnectionError


# --- Featherless / OpenAI-compatible client (vision + optional text) -------
_featherless_client = OpenAI(
    api_key=os.environ.get("FEATHERLESS_API_KEY"),
    base_url="https://api.featherless.ai/v1",
)

# The vision client is always Featherless — we are NOT moving extraction.
vision_client = _featherless_client
VISION_MODEL = FEATHERLESS_VISION_MODEL


# --- Anthropic client (lazy: only built if actually selected) --------------
_anthropic_client = None


def _get_anthropic_client():
    global _anthropic_client
    if _anthropic_client is None:
        # Imported lazily so the dependency is only needed when used.
        from anthropic import Anthropic, APIError as AnthAPIError, APIConnectionError as AnthConnError
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError(
                "EXPLANATION_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. "
                "Add it to api/.env, or set EXPLANATION_PROVIDER=featherless."
            )
        _anthropic_client = Anthropic(api_key=key)
        # stash the anthropic-specific exceptions for the call site
        _anthropic_client._anth_errors = (AnthAPIError, AnthConnError)
    return _anthropic_client


def complete_text(system_prompt: str, user_prompt: str, max_tokens: int = 300) -> str:
    """
    Single text-completion call, routed to the configured explanation provider.
    Returns the stripped text. Raises ProviderAPIError / ProviderConnectionError
    on failure so the caller can handle both providers with one except clause.
    """
    if EXPLANATION_PROVIDER == "anthropic":
        client = _get_anthropic_client()
        try:
            # Anthropic: system is a TOP-LEVEL param, not a system-role message.
            msg = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
            # content is a list of blocks; concatenate any text blocks.
            parts = [b.text for b in msg.content if getattr(b, "type", None) == "text"]
            return "".join(parts).strip()
        except client._anth_errors as e:  # type: ignore[attr-defined]
            logger.error(f"Anthropic API error: {e}")
            # Normalise to the OpenAI error type the caller already catches.
            raise ProviderConnectionError(request=None) from e

    # Default: Featherless (OpenAI-compatible), system as a system-role message.
    response = _featherless_client.chat.completions.create(
        model=FEATHERLESS_MODEL,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    return response.choices[0].message.content.strip()
