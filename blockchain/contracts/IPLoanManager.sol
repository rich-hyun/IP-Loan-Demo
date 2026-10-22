// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPLoanAccessSBT} from "./IPLoanAccessSBT.sol";
import {IPLoanRWAToken} from "./IPLoanRWAToken.sol";

contract IPLoanManager is AccessControlEnumerable, ReentrancyGuard {
    bytes32 public constant BORROWER_ROLE = keccak256("BORROWER_ROLE");
    bytes32 public constant EVALUATOR_ROLE = keccak256("EVALUATOR_ROLE");
    bytes32 public constant BANK_ROLE = keccak256("BANK_ROLE");
    enum Status { None, Evaluating, Eligible, RuleRejected, Approved, Rejected, Repaid }
    struct Application {
        address borrower;
        string docCid;
        bytes32 fileHash;
        uint256 amount;
        string reportCid;
        bytes32 reportHash;
        uint256 appraisedValue;
        uint256 tokenId;
        uint256 repaidAmount;
        Status status;
        address evaluator;
        address bank;
        // Loan agreement fixed by the bank at final approval (v3). Credit grade, rate and term are confidential,
        // so only a salted hash of them is kept; the plaintext stays with the server.
        bytes32 termsHash;
        uint256 approvedAt;
        // Token metadata JSON on IPFS behind the fixed HTTPS gateway: the SBT's is fixed at submission,
        // the RWA token's at final approval. The server draws both cards; nothing confidential is on them.
        string sbtUri;
        string rwaUri;
    }
    uint256 public constant contractVersion = 3;
    string public constant tokenMediaGateway = "https://rwa-gw.mustree.kr/ipfs/";
    IPLoanAccessSBT public immutable accessSBT;
    IPLoanRWAToken public immutable rwaToken;
    uint256 public nextTokenId = 1;
    mapping(bytes32 => Application) private _applications;
    mapping(uint256 => bytes32) public applicationKey;
    mapping(bytes32 => bool) public repaymentReferences;
    error InvalidInput();
    error AlreadySubmitted(bytes32 appKey);
    error WrongStage(bytes32 appKey);
    error WrongEvaluator();
    error WrongBank();
    error DuplicateRepayment();
    event Submitted(bytes32 indexed appKey, address indexed borrower, address indexed evaluator, uint256 tokenId, string cid, bytes32 fileHash, uint256 amount);
    event EvaluationConfirmed(bytes32 indexed appKey, string reportCid, bytes32 reportHash, uint256 value, bool eligible, address indexed bank);
    event FinalApproved(bytes32 indexed appKey, address indexed bank, uint256 rwaTokenId, bytes32 termsHash);
    event FinalRejected(bytes32 indexed appKey);
    event RepaymentRecorded(bytes32 indexed appKey, bytes32 indexed paymentRef, uint256 amount, uint256 total, bool fullyRepaid);

    constructor(address admin, address evaluator_, address bank_) {
        if (admin == address(0) || evaluator_ == address(0) || bank_ == address(0) || evaluator_ == bank_) revert InvalidInput();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EVALUATOR_ROLE, evaluator_);
        _grantRole(BANK_ROLE, bank_);
        accessSBT = new IPLoanAccessSBT(address(this));
        rwaToken = new IPLoanRWAToken(address(this));
    }
    function getApplication(bytes32 appKey) external view returns (Application memory) { return _applications[appKey]; }
    // The borrower submits with the server-selected evaluator; it is fixed for this application.
    function submitApplication(bytes32 appKey, string calldata cid, bytes32 fileHash, uint256 amount, address evaluator_,
        string calldata sbtUri) external onlyRole(BORROWER_ROLE) nonReentrant {
        if (appKey == bytes32(0) || !_validCid(cid) || fileHash == bytes32(0) || amount == 0 || amount > type(uint128).max) revert InvalidInput();
        if (!_validMediaUri(sbtUri)) revert InvalidInput();
        if (_applications[appKey].status != Status.None) revert AlreadySubmitted(appKey);
        if (evaluator_ == address(0) || evaluator_ == msg.sender) revert InvalidInput();
        if (!hasRole(EVALUATOR_ROLE, evaluator_)) revert WrongEvaluator();
        uint256 tokenId = nextTokenId++;
        Application storage a = _applications[appKey];
        (a.borrower, a.docCid, a.fileHash, a.amount, a.tokenId) = (msg.sender, cid, fileHash, amount, tokenId);
        (a.status, a.evaluator, a.sbtUri) = (Status.Evaluating, evaluator_, sbtUri);
        applicationKey[tokenId] = appKey;
        accessSBT.mint(evaluator_, tokenId);
        emit Submitted(appKey, msg.sender, evaluator_, tokenId, cid, fileHash, amount);
    }
    // The evaluator confirms with the server-selected bank/reviewer, assigned only when the 70% rule passes.
    // A rule-rejected application has no bank, so bank_ must then be the zero address.
    function confirmEvaluation(bytes32 appKey, string calldata reportCid, bytes32 reportHash, uint256 value, address bank_)
        external onlyRole(EVALUATOR_ROLE) nonReentrant {
        Application storage a = _applications[appKey];
        if (msg.sender != a.evaluator) revert WrongEvaluator();
        if (a.status != Status.Evaluating) revert WrongStage(appKey);
        if (!_validCid(reportCid) || reportHash == bytes32(0) || value == 0 || value > type(uint128).max) revert InvalidInput();
        bool eligible = a.amount * 100 <= value * 70;
        if (eligible) {
            if (bank_ == address(0) || bank_ == a.evaluator || bank_ == a.borrower) revert InvalidInput();
            if (!hasRole(BANK_ROLE, bank_)) revert WrongBank();
            a.bank = bank_;
        } else if (bank_ != address(0)) revert InvalidInput();
        a.reportCid = reportCid; a.reportHash = reportHash; a.appraisedValue = value;
        a.status = eligible ? Status.Eligible : Status.RuleRejected;
        accessSBT.burn(a.tokenId);
        emit EvaluationConfirmed(appKey, reportCid, reportHash, value, eligible, bank_);
    }
    /// Creates the loan agreement: the hash of the agreed credit grade, rate and term is fixed on chain,
    /// and the RWA token is minted to the assigned bank in the same transaction.
    function finalApprove(bytes32 appKey, bytes32 termsHash, string calldata rwaUri) external onlyRole(BANK_ROLE) nonReentrant {
        Application storage a = _applications[appKey];
        if (a.status != Status.Eligible) revert WrongStage(appKey);
        if (msg.sender != a.bank) revert WrongBank();
        if (termsHash == bytes32(0) || !_validMediaUri(rwaUri)) revert InvalidInput();
        a.status = Status.Approved;
        (a.termsHash, a.approvedAt, a.rwaUri) = (termsHash, block.timestamp, rwaUri);
        rwaToken.mint(a.bank, a.tokenId);
        emit FinalApproved(appKey, a.bank, a.tokenId, termsHash);
    }
    function finalReject(bytes32 appKey) external onlyRole(BANK_ROLE) nonReentrant {
        Application storage a = _applications[appKey];
        if (a.status != Status.Eligible) revert WrongStage(appKey);
        if (msg.sender != a.bank) revert WrongBank();
        a.status = Status.Rejected;
        emit FinalRejected(appKey);
    }
    /// Records a bank-confirmed DEMO payment. Never transfers ETH/MST/ERC20 funds.
    function recordRepayment(bytes32 appKey, uint256 amount, bytes32 paymentRef)
        external onlyRole(BANK_ROLE) nonReentrant {
        Application storage a = _applications[appKey];
        if (a.status != Status.Approved) revert WrongStage(appKey);
        if (msg.sender != a.bank) revert WrongBank();
        if (amount == 0 || amount > a.amount - a.repaidAmount || paymentRef == bytes32(0)) revert InvalidInput();
        bytes32 key = keccak256(abi.encode(appKey, paymentRef));
        if (repaymentReferences[key]) revert DuplicateRepayment();
        repaymentReferences[key] = true;
        a.repaidAmount += amount;
        if (a.repaidAmount == a.amount) a.status = Status.Repaid;
        emit RepaymentRecorded(appKey, paymentRef, amount, a.repaidAmount, a.status == Status.Repaid);
    }
    function metadata(uint256 tokenId, bool rwa) external view returns (string memory) {
        Application storage a = _applications[applicationKey[tokenId]];
        if (a.status == Status.None) revert InvalidInput();
        return rwa ? a.rwaUri : a.sbtUri;
    }
    // Only <gateway><CID>: no other host, scheme, path or query.
    function _validMediaUri(string calldata uri) private pure returns (bool) {
        bytes memory value = bytes(uri);
        bytes memory gateway = bytes(tokenMediaGateway);
        if (value.length <= gateway.length) return false;
        for (uint256 i; i < gateway.length; ++i) if (value[i] != gateway[i]) return false;
        return _validCid(uri[gateway.length:]);
    }
    function _validCid(string calldata cid) private pure returns (bool) {
        bytes memory v = bytes(cid);
        if (v.length < 10 || v.length > 128) return false;
        for (uint256 i; i < v.length; ++i) {
            bytes1 c = v[i];
            if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return false;
        }
        return true;
    }
}
