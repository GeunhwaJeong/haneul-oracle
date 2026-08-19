# Copyright (c) Mysten Labs, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Regenerate wormhole test VAA fixtures for Haneul's chain ID.
#
# Upstream test fixtures are governance VAAs whose payload targets chain 21
# and are signed by the public devnet guardian key. Since our CHAIN_ID is
# 8282, every "local action" fixture must encode 8282 instead, and the body
# must be re-signed (the chain ID is under the guardian signature).
#
# Only VAAs that are unambiguously Core-module governance messages targeting
# chain 21 are touched: payload = 32-byte module name ending in "Core",
# 1-byte action, 2-byte target chain == 21. Global VAAs (chain 0) and
# non-governance fixtures are left untouched.
#
# Usage: uv run --with coincurve --with pycryptodome scripts/resign_test_vaas.py <dir>

import re
import sys
from pathlib import Path

from coincurve import PrivateKey, PublicKey
from Crypto.Hash import keccak

# Tilt/devnet guardian #0 keypair, public knowledge from the wormhole repo.
DEVNET_GUARDIAN_SECRET = bytes.fromhex(
    "cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0"
)
DEVNET_GUARDIAN_ADDRESS = bytes.fromhex("befa429d57cd18b7f8a4d91a2da9ab4af05d0fbe")

# Guardians allowed to appear as the original fixture signer. Pyth's own test
# guardian has no published secret, so those fixtures are re-signed with the
# devnet key and the test setup is switched to the devnet guardian address.
KNOWN_ORIGINAL_SIGNERS = {
    DEVNET_GUARDIAN_ADDRESS,
    bytes.fromhex("13947bd48b18e53fdaeee77f3473391ac727c638"),
}

OLD_CHAIN = 21
NEW_CHAIN = 8282


def kk(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def eth_address(pubkey: PublicKey) -> bytes:
    return kk(pubkey.format(compressed=False)[1:])[-20:]


assert eth_address(PrivateKey(DEVNET_GUARDIAN_SECRET).public_key) == DEVNET_GUARDIAN_ADDRESS


def try_rewrite_vaa(hexstr: str) -> str | None:
    raw = bytes.fromhex(hexstr)
    if len(raw) < 6 or raw[0] != 1:
        return None
    gsi = raw[1:5]
    nsig = raw[5]
    body_off = 6 + 66 * nsig
    if len(raw) < body_off + 51 + 8:
        return None
    body = raw[body_off:]
    payload = body[51:]
    # Two governance payload layouts carry a target chain:
    # - Wormhole Core: 32-byte module name ending in "Core", action u8, chain u16
    # - Pyth ("PTGM" magic): magic 4B, module u8, action u8, chain u16
    if len(payload) >= 35 and payload[:28] == b"\x00" * 28 and payload[28:32] == b"Core":
        chain_off = 33
    elif payload[:4] == b"PTGM":
        chain_off = 6
    else:
        return None
    chain = int.from_bytes(payload[chain_off : chain_off + 2], "big")
    if chain != OLD_CHAIN:
        return None

    new_payload = (
        payload[:chain_off] + NEW_CHAIN.to_bytes(2, "big") + payload[chain_off + 2 :]
    )
    new_body = body[:51] + new_payload
    digest = kk(kk(new_body))

    # Every local fixture is signed by the single devnet guardian; verify that
    # assumption against the original signature before re-signing.
    sigs = []
    for i in range(nsig):
        off = 6 + 66 * i
        guardian_index = raw[off]
        rs, v = raw[off + 1 : off + 65], raw[off + 65]
        recovered = eth_address(
            PublicKey.from_signature_and_message(rs + bytes([v]), kk(kk(body)), hasher=None)
        )
        if recovered not in KNOWN_ORIGINAL_SIGNERS:
            raise RuntimeError(f"fixture signed by unknown guardian {recovered.hex()}")
        new_sig = PrivateKey(DEVNET_GUARDIAN_SECRET).sign_recoverable(digest, hasher=None)
        sigs.append(bytes([guardian_index]) + new_sig)

    out = raw[:6] if nsig else raw[:6]
    out = raw[0:1] + gsi + bytes([nsig]) + b"".join(sigs) + new_body
    # Sanity: re-recover from the fresh signature.
    for i in range(nsig):
        off = 6 + 66 * i
        rs, v = out[off + 1 : off + 65], out[off + 65]
        assert (
            eth_address(PublicKey.from_signature_and_message(rs + bytes([v]), digest, hasher=None))
            == DEVNET_GUARDIAN_ADDRESS
        )
    return out.hex()


def main(root: Path) -> None:
    pattern = re.compile(r'x"([0-9a-fA-F]{120,})"')
    changed = 0
    for path in sorted(root.rglob("*.move")):
        text = path.read_text()

        def repl(m: re.Match) -> str:
            nonlocal changed
            new = try_rewrite_vaa(m.group(1))
            if new is None:
                return m.group(0)
            changed += 1
            print(f"  rewrote fixture in {path.name} ({len(new) // 2} bytes)")
            return f'x"{new}"'

        new_text = pattern.sub(repl, text)
        if new_text != text:
            path.write_text(new_text)
    print(f"done: {changed} fixtures rewritten")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
