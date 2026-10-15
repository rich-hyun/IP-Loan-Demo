// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPLoanAccessSBT} from "./IPLoanAccessSBT.sol";
import {IPLoanDebtNFT} from "./IPLoanDebtNFT.sol";

contract IPLoanManager is AccessControl, ReentrancyGuard {
    using Strings for uint256;
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
    }
    address public immutable evaluator;
    address public immutable bank;
    IPLoanAccessSBT public immutable accessSBT;
    IPLoanDebtNFT public immutable debtNFT;
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
    event Submitted(bytes32 indexed appKey, address indexed borrower, uint256 tokenId, string cid, bytes32 fileHash, uint256 amount);
    event EvaluationConfirmed(bytes32 indexed appKey, string reportCid, bytes32 reportHash, uint256 value, bool eligible);
    event FinalApproved(bytes32 indexed appKey, address indexed bank, uint256 debtTokenId);
    event FinalRejected(bytes32 indexed appKey);
    event RepaymentRecorded(bytes32 indexed appKey, bytes32 indexed paymentRef, uint256 amount, uint256 total, bool fullyRepaid);

    constructor(address admin, address evaluator_, address bank_) {
        if (admin == address(0) || evaluator_ == address(0) || bank_ == address(0) || evaluator_ == bank_) revert InvalidInput();
        evaluator = evaluator_; bank = bank_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EVALUATOR_ROLE, evaluator_);
        _grantRole(BANK_ROLE, bank_);
        accessSBT = new IPLoanAccessSBT(address(this));
        debtNFT = new IPLoanDebtNFT(address(this));
    }
    function getApplication(bytes32 appKey) external view returns (Application memory) { return _applications[appKey]; }
    function submitApplication(bytes32 appKey, string calldata cid, bytes32 fileHash, uint256 amount)
        external onlyRole(BORROWER_ROLE) nonReentrant {
        if (appKey == bytes32(0) || !_validCid(cid) || fileHash == bytes32(0) || amount == 0 || amount > type(uint128).max) revert InvalidInput();
        if (_applications[appKey].status != Status.None) revert AlreadySubmitted(appKey);
        if (!hasRole(EVALUATOR_ROLE, evaluator)) revert WrongEvaluator();
        uint256 tokenId = nextTokenId++;
        _applications[appKey] = Application(msg.sender, cid, fileHash, amount, "", bytes32(0), 0, tokenId, 0, Status.Evaluating);
        applicationKey[tokenId] = appKey;
        accessSBT.mint(evaluator, tokenId);
        emit Submitted(appKey, msg.sender, tokenId, cid, fileHash, amount);
    }
    function confirmEvaluation(bytes32 appKey, string calldata reportCid, bytes32 reportHash, uint256 value)
        external onlyRole(EVALUATOR_ROLE) nonReentrant {
        if (msg.sender != evaluator) revert WrongEvaluator();
        Application storage a = _applications[appKey];
        if (a.status != Status.Evaluating) revert WrongStage(appKey);
        if (!_validCid(reportCid) || reportHash == bytes32(0) || value == 0 || value > type(uint128).max) revert InvalidInput();
        a.reportCid = reportCid; a.reportHash = reportHash; a.appraisedValue = value;
        bool eligible = a.amount * 100 <= value * 70;
        a.status = eligible ? Status.Eligible : Status.RuleRejected;
        accessSBT.burn(a.tokenId);
        emit EvaluationConfirmed(appKey, reportCid, reportHash, value, eligible);
    }
    function finalApprove(bytes32 appKey) external onlyRole(BANK_ROLE) nonReentrant {
        if (msg.sender != bank) revert WrongBank();
        Application storage a = _applications[appKey];
        if (a.status != Status.Eligible) revert WrongStage(appKey);
        a.status = Status.Approved;
        debtNFT.mint(bank, a.tokenId);
        emit FinalApproved(appKey, bank, a.tokenId);
    }
    function finalReject(bytes32 appKey) external onlyRole(BANK_ROLE) nonReentrant {
        if (msg.sender != bank) revert WrongBank();
        Application storage a = _applications[appKey];
        if (a.status != Status.Eligible) revert WrongStage(appKey);
        a.status = Status.Rejected;
        emit FinalRejected(appKey);
    }
    /// Records a bank-confirmed DEMO payment. Never transfers ETH/MST/ERC20 funds.
    function recordRepayment(bytes32 appKey, uint256 amount, bytes32 paymentRef)
        external onlyRole(BANK_ROLE) nonReentrant {
        if (msg.sender != bank) revert WrongBank();
        Application storage a = _applications[appKey];
        if (a.status != Status.Approved) revert WrongStage(appKey);
        if (amount == 0 || amount > a.amount - a.repaidAmount || paymentRef == bytes32(0)) revert InvalidInput();
        bytes32 key = keccak256(abi.encode(appKey, paymentRef));
        if (repaymentReferences[key]) revert DuplicateRepayment();
        repaymentReferences[key] = true;
        a.repaidAmount += amount;
        if (a.repaidAmount == a.amount) a.status = Status.Repaid;
        emit RepaymentRecorded(appKey, paymentRef, amount, a.repaidAmount, a.status == Status.Repaid);
    }
    function metadata(uint256 tokenId, bool debt) external view returns (string memory) {
        Application storage a = _applications[applicationKey[tokenId]];
        if (a.status == Status.None) revert InvalidInput();
        bytes memory data = abi.encodePacked('{"name":"', debt ? "IP Loan Demo Debt #" : "IP Loan Appraisal Access #", tokenId.toString(),
            '","cid":"', a.docCid, '","fileHash":"', Strings.toHexString(uint256(a.fileHash), 32),
            '","enc":"AES-256-GCM","status":', uint256(a.status).toString(), ',"repaidAmount":"', a.repaidAmount.toString(), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(data));
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
