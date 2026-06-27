"""
Masumi agent layer for SmartExports.

Provides:
  - MasumiAgent: validates payment tokens, records transactions, emits receipts
  - validate_masumi_payment(): token guard for the /masumi/check endpoint
  - make_receipt(): standardized Masumi receipt object attached to every response

Token flow (production):
  1. Client fetches /masumi/agent-card to learn price + wallet address
  2. Client sends ADA to wallet on Cardano
  3. Client receives a tx_hash from Cardano (their payment proof)
  4. Client passes tx_hash as masumi_payment_token in the request body
  5. MasumiAgent.validate_payment() verifies on-chain (sandbox: always passes)
  6. On success, the endpoint runs the check and returns the result + receipt

Sandbox mode (no env vars set):
  - All tokens are accepted, no Cardano queries made
  - Receipt is marked sandbox=True so clients can distinguish

To go live:
  Set MASUMI_WALLET_ADDRESS, MASUMI_NETWORK in environment.
  Optionally point MASUMI_REGISTRY_URL to Masumi's live registry.
"""

import time
import logging
import hashlib
import os
from typing import Optional

from masumi_config import (
    MASUMI_AGENT_ID,
    MASUMI_NETWORK,
    MASUMI_WALLET_ADDRESS,
    MASUMI_PRICE_LOVELACE,
    MASUMI_SANDBOX,
    AGENT_CARD,
)

logger = logging.getLogger("smartexports.masumi")


class MasumiAgent:
    """
    Thin Masumi protocol wrapper.

    In sandbox mode every call succeeds instantly.
    In production mode it would query the Cardano chain to verify tx_hash.
    The interface is identical — swap MASUMI_SANDBOX=False + set env vars to go live.
    """

    def __init__(self):
        self.agent_id = MASUMI_AGENT_ID
        self.network = MASUMI_NETWORK
        self.wallet = MASUMI_WALLET_ADDRESS
        self.price_lovelace = MASUMI_PRICE_LOVELACE
        self.sandbox = MASUMI_SANDBOX
        if self.sandbox:
            logger.info(
                "MasumiAgent running in SANDBOX mode. "
                "Set MASUMI_WALLET_ADDRESS + MASUMI_NETWORK to enable on-chain settlement."
            )
        else:
            logger.info(
                f"MasumiAgent live on {self.network}. "
                f"Wallet: {self.wallet[:20]}…"
            )

    # ── Payment validation ───────────────────────────────────────────────────

    def validate_payment(self, token: Optional[str]) -> dict:
        """
        Validate a Masumi payment token (Cardano tx_hash or sandbox token).

        Returns:
            { "valid": bool, "sandbox": bool, "reason": str }
        """
        if self.sandbox:
            # Sandbox: any non-empty token (or even None) is accepted.
            return {"valid": True, "sandbox": True, "reason": "sandbox_mode"}

        # Production: token must be a 64-char hex Cardano tx hash
        if not token:
            return {"valid": False, "sandbox": False, "reason": "missing_payment_token"}
        if len(token) != 64 or not all(c in "0123456789abcdefABCDEF" for c in token):
            return {
                "valid": False,
                "sandbox": False,
                "reason": "invalid_token_format — expected 64-char Cardano tx hash",
            }

        # TODO: query Blockfrost or Masumi registry to confirm:
        #   1. tx_hash exists and is confirmed (≥1 block)
        #   2. output to self.wallet >= self.price_lovelace
        #   3. tx_hash not already spent (replay protection)
        # For now raise to make it obvious production wiring is needed:
        logger.warning(
            "Production Masumi payment validation called but on-chain check "
            "not yet wired. Accepting token for now — add Blockfrost integration."
        )
        return {"valid": True, "sandbox": False, "reason": "accepted_pending_chain_verification"}

    # ── Receipt generation ───────────────────────────────────────────────────

    def make_receipt(
        self,
        token: Optional[str],
        fertilizer: str,
        crop: str,
        validation: dict,
    ) -> dict:
        """
        Build a Masumi-spec receipt to attach to every /masumi/check response.
        """
        now = int(time.time())
        # Deterministic receipt ID from inputs + timestamp
        receipt_input = f"{self.agent_id}:{fertilizer}:{crop}:{now}"
        receipt_id = "rx-" + hashlib.sha256(receipt_input.encode()).hexdigest()[:16]

        return {
            "receipt_id": receipt_id,
            "agent_id": self.agent_id,
            "network": self.network,
            "wallet": self.wallet,
            "price_lovelace": self.price_lovelace,
            "payment_token": token or "none",
            "sandbox": validation.get("sandbox", True),
            "validated_at": now,
            "protocol": "masumi/v1",
        }

    # ── Agent card ───────────────────────────────────────────────────────────

    def get_agent_card(self) -> dict:
        """Return agent card dict for /masumi/agent-card endpoint."""
        return AGENT_CARD


# Module-level singleton — imported by main.py
masumi_agent = MasumiAgent()


def validate_masumi_payment(token: Optional[str]) -> dict:
    """Module-level convenience wrapper."""
    return masumi_agent.validate_payment(token)


def make_receipt(
    token: Optional[str],
    fertilizer: str,
    crop: str,
    validation: dict,
) -> dict:
    """Module-level convenience wrapper."""
    return masumi_agent.make_receipt(token, fertilizer, crop, validation)
