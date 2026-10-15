"""Read-only chain verification. No signing keys or transaction broadcasting here."""
import json
import os
from pathlib import Path
from web3 import Web3

RPC_URL = os.environ.get("IPLOAN_RPC_URL", "https://block.mustree.kr")
CHAIN_ID = int(os.environ.get("IPLOAN_CHAIN_ID", "7601"))
MANAGER_ADDRESS = os.environ.get("IPLOAN_MANAGER_ADDRESS", "").strip()
ARTIFACT = Path(__file__).resolve().parents[1] / "blockchain/artifacts/IPLoanManager.json"
TOKEN_ABI = [{"type": "function", "name": "ownerOf", "stateMutability": "view", "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"name": "owner", "type": "address"}]}]
FIELDS = ["borrower", "docCid", "fileHash", "amount", "reportCid", "reportHash", "appraisedValue", "tokenId", "repaidAmount", "status"]
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

def config():
    network_name, currency = {31337: ("Local MVP", "ETH"), 11155111: ("Sepolia", "ETH"),
                              7601: ("Mustsem", "MST")}.get(CHAIN_ID, (f"Chain {CHAIN_ID}", "ETH"))
    result = {"enabled": bool(MANAGER_ADDRESS), "chainId": CHAIN_ID, "rpcUrl": RPC_URL,
              "networkName": network_name, "currency": currency}
    if CHAIN_ID == 11155111:
        result["explorerUrl"] = "https://sepolia.etherscan.io"
    result["zeroGasPrice"] = CHAIN_ID == 7601 and os.environ.get("IPLOAN_ZERO_GAS_PRICE", "").lower() in {"1", "true"}
    if CHAIN_ID == 7601 and os.environ.get("IPLOAN_PENDING_DEPLOYMENT_TX"):
        result["pendingDeploymentTxHash"] = os.environ["IPLOAN_PENDING_DEPLOYMENT_TX"]
    if not MANAGER_ADDRESS:
        return result
    _, manager = _manager()
    try:
        result.update(managerAddress=manager.address, abi=manager.abi,
                      evaluatorWallet=manager.functions.evaluator().call(), bankWallet=manager.functions.bank().call(),
                      accessSBTAddress=manager.functions.accessSBT().call(), debtNFTAddress=manager.functions.debtNFT().call())
        return result
    except Exception as exc:
        raise ChainError("MVP 계약 설정을 조회하지 못했습니다.") from exc

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
        evaluator = manager.functions.evaluator().call(block_identifier=block)
        bank = manager.functions.bank().call(block_identifier=block)
        if evaluator.lower() != application["evaluatorWallet"].lower() or bank.lower() != application["bankWallet"].lower():
            raise ChainError("체인의 평가사·은행이 신청 당시 설정과 다릅니다.")
        token_id = record["tokenId"]
        if status == 1:
            token_address = manager.functions.accessSBT().call(block_identifier=block)
            owner = w3.eth.contract(address=token_address, abi=TOKEN_ABI).functions.ownerOf(token_id).call(block_identifier=block)
            if owner.lower() != evaluator.lower():
                raise ChainError("평가 SBT 소유자가 다릅니다.")
        elif status in (4, 6):
            token_address = manager.functions.debtNFT().call(block_identifier=block)
            owner = w3.eth.contract(address=token_address, abi=TOKEN_ABI).functions.ownerOf(token_id).call(block_identifier=block)
            if owner.lower() != bank.lower():
                raise ChainError("채권 NFT 소유자가 은행 주소와 다릅니다.")
        return {"chainStatus": STAGES[status], "chainBlock": block, "sbtTokenId": str(token_id),
                "debtTokenId": str(token_id) if status in (4, 6) else None,
                "reportCid": record["reportCid"], "reportHash": Web3.to_hex(record["reportHash"]),
                "appraisedValue": record["appraisedValue"], "repaidAmount": record["repaidAmount"]}
    except ChainError:
        raise
    except Exception as exc:
        raise ChainError("체인 상태·토큰 소유권을 확인하지 못했습니다.") from exc
