// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ILoanMetadata} from "./IPLoanAccessSBT.sol";

/// MVP receipt held by the bank; trading/real legal claims are outside this demo.
contract IPLoanDebtNFT is ERC721 {
    address public immutable manager;
    error ManagerOnly();
    constructor(address manager_) ERC721("IP Loan Demo Debt", "IPLD") { manager = manager_; }
    function mint(address bank, uint256 tokenId) external {
        if (msg.sender != manager) revert ManagerOnly();
        _safeMint(bank, tokenId);
    }
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId); return ILoanMetadata(manager).metadata(tokenId, true);
    }
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (msg.sender != manager) revert ManagerOnly();
        return super._update(to, tokenId, auth);
    }
}
