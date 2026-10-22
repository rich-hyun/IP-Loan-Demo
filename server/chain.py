"""Read-only chain verification. No signing keys or transaction broadcasting here."""
import json
import os
import secrets
from pathlib import Path
from web3 import Web3

RPC_URL = os.environ.get("IPLOAN_RPC_URL", "https://block.mustree.kr")
CHAIN_ID = int(os.environ.get("IPLOAN_CHAIN_ID", "7601"))
MANAGER_ADDRESS = os.environ.get("IPLOAN_MANAGER_ADDRESS", "").strip()
ARTIFACT = Path(__file__).resolve().parents[1] / "blockchain/artifacts/IPLoanManager.json"
TOKEN_ABI = [{"type": "function", "name": "ownerOf", "stateMutability": "view", "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"name": "owner", "type": "address"}]}]
FIELDS = ["borrower", "docCid", "fileHash", "amount", "reportCid", "reportHash", "appraisedValue", "tokenId", "repaidAmount", "status",
          "evaluator", "bank", "termsHash", "approvedAt", "sbtUri", "rwaUri"]
CONTRACT_VERSION = 3
ROLE_NAMES = {"BORROWER_ROLE": "borrower", "EVALUATOR_ROLE": "evaluator", "BANK_ROLE": "bank"}
ADMIN_ROLE_ID = b"\x00" * 32
STAGES = ["None", "Evaluating", "Eligible", "RuleRejected", "Approved", "Rejected", "Repaid"]

class ChainError(Exception):
    pass

def address(value):
    if not isinstance(value, str) or not Web3.is_address(value) or int(value, 16) == 0:
        raise ChainError("올바른 공개 지갑 주소를 입력해 주세요.")
    return Web3.to_checksum_address(value)

def _manager():
    if not MANAGER_ADDRESS:
        raise ChainError("온체인 계약 주소가 설정되지 않았습니다.")
    if not ARTIFACT.exists():
        raise ChainError("먼저 blockchain에서 npm run compile을 실행해 주세요.")
    try:
        w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 10}))
        if w3.eth.chain_id != CHAIN_ID:
            raise ChainError("RPC의 체인 ID가 서버 설정과 다릅니다.")
        target = address(MANAGER_ADDRESS)
        if not w3.eth.get_code(target):
            raise ChainError("설정한 주소에 계약이 없습니다.")
        abi = json.loads(ARTIFACT.read_text(encoding="utf-8"))["abi"]
        return w3, w3.eth.contract(address=target, abi=abi)
    except ChainError:
        raise
    except Exception as exc:
        raise ChainError("체인 RPC에 연결하지 못했습니다.") from exc


def role_members(manager, role, block="latest"):
    role_id = Web3.keccak(text=role)
    count = manager.functions.getRoleMemberCount(role_id).call(block_identifier=block)
    return [manager.functions.getRoleMember(role_id, i).call(block_identifier=block) for i in range(count)]

def config():
    network_name, currency = {31337: ("Local MVP", "ETH"), 11155111: ("Sepolia", "ETH"),
                              7601: ("Mustsem", "MST")}.get(CHAIN_ID, (f"Chain {CHAIN_ID}", "ETH"))
    result = {"enabled": bool(MANAGER_ADDRESS), "chainId": CHAIN_ID, "rpcUrl": RPC_URL,
              "networkName": network_name, "currency": currency}
    if CHAIN_ID == 11155111:
        result["explorerUrl"] = "https://sepolia.etherscan.io"
    result["zeroGasPrice"] = CHAIN_ID == 7601 and os.environ.get("IPLOAN_ZERO_GAS_PRICE", "").lower() in {"1", "true"}
    if not MANAGER_ADDRESS:
        return result
    w3, manager = _manager()
    try:
        if manager.functions.contractVersion().call() != CONTRACT_VERSION:
            raise ChainError("설정한 주소가 v3 Manager 계약이 아닙니다.")
        block = w3.eth.block_number
        result.update(managerAddress=manager.address, abi=manager.abi, contractVersion=CONTRACT_VERSION, blockNumber=block,
                      accessSBTAddress=manager.functions.accessSBT().call(), rwaTokenAddress=manager.functions.rwaToken().call(),
                      roleMembers={role: role_members(manager, role, block) for role in ["BORROWER_ROLE", "EVALUATOR_ROLE", "BANK_ROLE"]})
        return result
    except ChainError:
        raise
    except Exception as exc:
        raise ChainError("MVP 계약 설정을 조회하지 못했습니다.") from exc


def _select(cfg, role, setting, excluded):
    """Select only from on-chain role holders; caller-provided participant fields are never used."""
    members = [address(wallet) for wallet in cfg["roleMembers"][role]]
    preferred = os.environ.get(setting, "").strip()
    if preferred:
        preferred = address(preferred)
        if preferred not in members:
            raise ChainError(f"{setting} 주소에 {role} 권한이 없습니다.")
        members = [preferred]
    candidates = [wallet for wallet in members if wallet.lower() not in {x.lower() for x in excluded}]
    if not candidates:
        raise ChainError(f"배정 가능한 {role} 주소가 없습니다. 관리자가 주소를 등록하거나 배정 설정을 수정하세요.")
    return secrets.choice(candidates)


def select_evaluator(cfg, borrower):
    """Assigned when the application is created."""
    return _select(cfg, "EVALUATOR_ROLE", "IPLOAN_ASSIGNMENT_EVALUATOR", {borrower})


def select_bank(cfg, evaluator, borrower):
    """Assigned when an evaluation that passes the 70% rule is prepared."""
    return _select(cfg, "BANK_ROLE", "IPLOAN_ASSIGNMENT_BANK", {evaluator, borrower})


def eligible(amount, appraised_value):
    return amount * 100 <= appraised_value * 70

def require_role(wallet, role):
    _, manager = _manager()
    try:
        role_id = Web3.keccak(text=role)
        if not manager.functions.hasRole(role_id, address(wallet)).call():
            raise ChainError("이 지갑에 필요한 역할이 없습니다. 관리자에게 역할 등록을 요청하세요.")
    except ChainError:
        raise
    except Exception as exc:
        raise ChainError("지갑 역할을 확인하지 못했습니다.") from exc

def has_role(wallet, role):
    _, manager = _manager()
    try:
        return manager.functions.hasRole(Web3.keccak(text=role), address(wallet)).call()
    except Exception as exc:
        raise ChainError("지갑 역할을 확인하지 못했습니다.") from exc

def roles(wallet):
    """Current on-chain roles of a wallet, as login role names (borrower/evaluator/bank/admin)."""
    _, manager = _manager()
    try:
        wallet = address(wallet)
        held = [name for role, name in ROLE_NAMES.items() if manager.functions.hasRole(Web3.keccak(text=role), wallet).call()]
        if manager.functions.hasRole(ADMIN_ROLE_ID, wallet).call():
            held.append("admin")
        return held
    except ChainError:
        raise
    except Exception as exc:
        raise ChainError("지갑 역할을 확인하지 못했습니다.") from exc

def snapshot(application):
    w3, manager = _manager()
    if application.get("managerAddress", "").lower() != manager.address.lower() or application.get("chainId") != CHAIN_ID:
        raise ChainError("신청에 저장된 계약·체인과 현재 서버 설정이 다릅니다.")
    try:
        block = w3.eth.block_number
        values = manager.functions.getApplication(application["appKey"]).call(block_identifier=block)
        record = dict(zip(FIELDS, values))
        status = int(record["status"])
        if status == 0:
            return {"chainStatus": "None", "chainBlock": block}
        if status not in range(1, len(STAGES)) or (
            record["borrower"].lower() != application["borrowerWallet"].lower()
            or record["docCid"] != application["docCid"]
            or Web3.to_hex(record["fileHash"]).lower() != application["docFileHash"].lower()
            or record["amount"] != application["amount"]
        ):
            raise ChainError("체인 신청 내용이 서버에 저장된 신청·CID·해시와 다릅니다.")
        evaluator, bank = record["evaluator"], record["bank"]
        if evaluator.lower() != (application.get("evaluatorWallet") or "").lower():
            raise ChainError("체인의 평가사가 서버가 배정한 담당자와 다릅니다.")
        # The bank is assigned at evaluation; before that (and after a rule rejection) it is the zero address.
        if status in (1, 3):
            if int(bank, 16) != 0:
                raise ChainError("배정 전 단계인데 체인에 은행 주소가 기록돼 있습니다.")
        elif bank.lower() != (application.get("bankWallet") or "").lower():
            raise ChainError("체인의 은행·여신심사역이 서버가 배정한 담당자와 다릅니다.")
        # Token cards: the wallet shows whatever URI the chain holds, so it must be the one the server drew.
        if record["sbtUri"] != (application.get("sbtMetadataUri") or ""):
            raise ChainError("체인의 SBT 카드 주소가 서버가 만든 카드와 다릅니다.")
        if status in (4, 6) and record["rwaUri"] != (application.get("rwaMetadataUri") or ""):
            raise ChainError("체인의 RWA 토큰 카드 주소가 서버가 만든 카드와 다릅니다.")
        token_id = record["tokenId"]
        if status == 1:
            token_address = manager.functions.accessSBT().call(block_identifier=block)
            owner = w3.eth.contract(address=token_address, abi=TOKEN_ABI).functions.ownerOf(token_id).call(block_identifier=block)
            if owner.lower() != evaluator.lower():
                raise ChainError("평가 SBT 소유자가 다릅니다.")
        elif status in (4, 6):
            token_address = manager.functions.rwaToken().call(block_identifier=block)
            owner = w3.eth.contract(address=token_address, abi=TOKEN_ABI).functions.ownerOf(token_id).call(block_identifier=block)
            if owner.lower() != bank.lower():
                raise ChainError("RWA 토큰 소유자가 은행 주소와 다릅니다.")
        result = {} if status != 3 else {"bankWallet": None}  # a rule rejection clears a bank prepared for an earlier draft
        approved = status in (4, 6)
        # The agreement exists only once the bank has approved on chain; the chain holds just the hash of its terms.
        return {**result, "chainStatus": STAGES[status], "chainBlock": block, "sbtTokenId": str(token_id),
                "rwaTokenId": str(token_id) if approved else None,
                "reportCid": record["reportCid"], "reportHash": Web3.to_hex(record["reportHash"]),
                "appraisedValue": record["appraisedValue"], "repaidAmount": record["repaidAmount"],
                "termsHash": Web3.to_hex(record["termsHash"]) if approved else None,
                "approvedAt": record["approvedAt"] if approved else None}
    except ChainError:
        raise
    except Exception as exc:
        raise ChainError("체인 상태·토큰 소유권을 확인하지 못했습니다.") from exc
