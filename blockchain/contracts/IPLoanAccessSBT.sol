// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

interface ILoanMetadata { function metadata(uint256 tokenId, bool debt) external view returns (string memory); }

contract IPLoanAccessSBT is ERC721 {
    address public immutable manager;
    error ManagerOnly();
    error Soulbound();
    event Locked(uint256 tokenId);
    constructor(address manager_) ERC721("IP Loan Appraisal Access", "IPLA") { manager = manager_; }
    modifier onlyManager() { if (msg.sender != manager) revert ManagerOnly(); _; }
    function mint(address to, uint256 tokenId) external onlyManager { _safeMint(to, tokenId); emit Locked(tokenId); }
    function burn(uint256 tokenId) external onlyManager { _requireOwned(tokenId); _burn(tokenId); }
    function locked(uint256 tokenId) external view returns (bool) { _requireOwned(tokenId); return true; }
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0xb45a3c0e || super.supportsInterface(interfaceId);
    }
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId); return ILoanMetadata(manager).metadata(tokenId, false);
    }
    function approve(address, uint256) public pure override { revert Soulbound(); }
    function setApprovalForAll(address, bool) public pure override { revert Soulbound(); }
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0) && to != address(0)) revert Soulbound();
        if (msg.sender != manager) revert ManagerOnly();
        return super._update(to, tokenId, auth);
    }
}
