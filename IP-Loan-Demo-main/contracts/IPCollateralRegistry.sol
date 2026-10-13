// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * Optional proof-of-concept contract. Requires audited OpenZeppelin v5.
 * Minting this NFT does NOT establish or transfer a legally effective IP right,
 * pledge or bank ownership. Legal agreements and registries are separate.
 */
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract IPCollateralRegistry is ERC721, AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant BANK_ROLE = keccak256("BANK_ROLE");

    uint256 public nextId = 1;
    mapping(uint256 => bytes32) public documentDigest;
    mapping(uint256 => bytes32) public reportDigest;
    mapping(uint256 => address) public pledgee;
    mapping(uint256 => bytes32) public ipIdentifierDigest;

    event IPRegistered(uint256 indexed tokenId, address indexed owner, bytes32 ipIdentifierDigest, bytes32 reportDigest);
    event ReportDigestUpdated(uint256 indexed tokenId, bytes32 digest);
    event CollateralPledged(uint256 indexed tokenId, address indexed bank);
    event CollateralReleased(uint256 indexed tokenId, address indexed bank);

    constructor(address admin) ERC721("IP Collateral PoC", "IP-DEMO") {
        require(admin != address(0), "admin required");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function registerIP(address borrower, bytes32 ipId, bytes32 reportHash, bytes32 docHash)
        external onlyRole(REGISTRAR_ROLE) returns (uint256 id) {
        require(borrower != address(0) && ipId != bytes32(0) && reportHash != bytes32(0), "invalid input");
        id = nextId++;
        ipIdentifierDigest[id] = ipId;
        reportDigest[id] = reportHash;
        documentDigest[id] = docHash;
        _safeMint(borrower, id);
        emit IPRegistered(id, borrower, ipId, reportHash);
    }

    function updateReportDigest(uint256 id, bytes32 hash) external onlyRole(REGISTRAR_ROLE) {
        require(_ownerOf(id) != address(0), "not minted");
        require(pledgee[id] == address(0), "already pledged");
        require(hash != bytes32(0), "empty hash");
        reportDigest[id] = hash;
        emit ReportDigestUpdated(id, hash);
    }

    function pledge(uint256 id, address bank) external onlyRole(REGISTRAR_ROLE) {
        require(_ownerOf(id) != address(0) && hasRole(BANK_ROLE, bank), "invalid bank or asset");
        require(pledgee[id] == address(0), "already pledged");
        pledgee[id] = bank;
        emit CollateralPledged(id, bank);
    }

    function release(uint256 id) external {
        address bank = pledgee[id];
        require(bank != address(0), "not pledged");
        require(msg.sender == bank || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "bank/admin only");
        delete pledgee[id];
        emit CollateralReleased(id, bank);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) {
            require(pledgee[tokenId] == address(0), "collateral locked");
        }
        return super._update(to, tokenId, auth);
    }
}
