// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// Token metadata with an on-chain SVG card, so wallets show each loan without any off-chain image host.
/// Every string drawn here is validated by the Manager (CIDs alphanumeric, grades A-Z/+/-), so nothing needs escaping.
contract IPLoanArt {
    using Strings for uint256;
    struct Card {
        uint256 tokenId;
        bool rwa;
        uint8 status;
        uint256 amount;
        uint256 appraisedValue;
        uint256 repaidAmount;
        string creditGrade;
        uint256 rateBps;
        uint256 termMonths;
        uint256 approvedAt;
        string docCid;
        bytes32 fileHash;
        string reportCid;
        bytes32 reportHash;
    }

    function tokenURI(Card calldata c) external pure returns (string memory) {
        string memory json = string.concat('{"name":"', c.rwa ? "IP Loan RWA #" : "IP Loan Appraisal Access #", c.tokenId.toString(),
            '","cid":"', c.docCid, '","fileHash":"', Strings.toHexString(uint256(c.fileHash), 32),
            '","enc":"AES-256-GCM","status":', uint256(c.status).toString(), ',"repaidAmount":"', c.repaidAmount.toString(), '"');
        if (c.rwa) {
            json = string.concat(json, ',"amount":"', c.amount.toString(), '","appraisedValue":"', c.appraisedValue.toString(),
                '","reportCid":"', c.reportCid, '","reportHash":"', Strings.toHexString(uint256(c.reportHash), 32),
                '","creditGrade":"', c.creditGrade, '","rateBps":', c.rateBps.toString(), ',"termMonths":', c.termMonths.toString(),
                ',"approvedAt":', c.approvedAt.toString());
        }
        json = string.concat(json, ',"description":"', c.rwa
                ? unicode"IP 담보대출 시범 서비스의 대출약정 RWA 토큰입니다. 실제 자금 이동과 법적 채권 효력은 없으며, 서류·보고서 원본은 암호화되어 IPFS에 있습니다."
                : unicode"담당 평가사의 특허등록원부 열람권입니다. 양도할 수 없고 평가가 확정되면 소각됩니다.",
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(c))), '","attributes":', _attributes(c), "}");
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _attributes(Card calldata c) private pure returns (string memory) {
        string memory list = string.concat('[{"trait_type":"', unicode"상태", '","value":"', _statusLabel(c.status),
            '"},{"trait_type":"', c.rwa ? unicode"약정 금액(원)" : unicode"신청 금액(원)", '","value":"', c.amount.toString(), '"}');
        if (c.rwa) {
            list = string.concat(list, ',{"trait_type":"', unicode"평가액(원)", '","value":"', c.appraisedValue.toString(),
                '"},{"trait_type":"', unicode"담보인정비율", '","value":"', _ltv(c), '"},{"trait_type":"', unicode"신용등급",
                '","value":"', _grade(c), '"},{"trait_type":"', unicode"금리·기간",
                '","value":"', _terms(c), '"},{"trait_type":"', unicode"상환액(원)", '","value":"', c.repaidAmount.toString(), '"}');
        }
        return string.concat(list, "]");
    }

    function _svg(Card calldata c) private pure returns (string memory) {
        (string memory from, string memory to) = _palette(c);
        string memory amount = string.concat(_commas(c.amount), unicode"원");
        string memory svg = string.concat(
            // Ligatures off: some Korean UI fonts draw "0x" as "0×".
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" font-family="Pretendard,Apple SD Gothic Neo,Malgun Gothic,Noto Sans KR,sans-serif" style="font-variant-ligatures:none">',
            '<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="', from,
            '"/><stop offset="1" stop-color="', to, '"/></linearGradient></defs><rect width="500" height="500" rx="28" fill="url(#b)"/>',
            '<g fill="none" stroke="#fff" stroke-opacity=".1" stroke-width="2"><circle cx="440" cy="60" r="130"/><circle cx="440" cy="60" r="86"/>',
            '<path d="M0 420c110-46 250 54 500-28"/></g>',
            // A patent document with a gold seal.
            '<rect x="36" y="34" width="50" height="62" rx="8" fill="#fff"/><path d="M47 52h28M47 63h28M47 74h16" stroke="', to,
            '" stroke-width="4" stroke-linecap="round"/><circle cx="80" cy="88" r="14" fill="#E0A100"/>',
            '<path d="m73 88 5 5 9-10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'
        );
        svg = string.concat(svg,
            '<text x="104" y="58" fill="#fff" fill-opacity=".78" font-size="14">', c.rwa ? unicode"IP 담보대출 · RWA 토큰" : unicode"IP 가치평가 열람권 · SBT",
            '</text><text x="104" y="88" fill="#fff" font-size="26" font-weight="800">', c.rwa ? "IP Loan #" : "Appraisal #", c.tokenId.toString(),
            '</text><text x="464" y="58" fill="#fff" fill-opacity=".6" font-size="12" text-anchor="end">Mustsem</text>',
            '<rect x="36" y="124" width="132" height="32" rx="16" fill="#fff" fill-opacity=".18"/>',
            '<text x="102" y="145" fill="#fff" font-size="14" font-weight="700" text-anchor="middle">', _statusLabel(c.status), "</text>",
            '<text x="36" y="200" fill="#fff" fill-opacity=".75" font-size="14">', c.rwa ? unicode"약정 금액" : unicode"신청 금액",
            '</text><text x="36" y="240" fill="#fff" font-size="', bytes(amount).length > 17 ? "24" : "34", '" font-weight="800">', amount, "</text>"
        );
        if (!c.rwa) {
            return string.concat(svg, _box(36, 268, unicode"등록원부 해시", _short(c.fileHash)), _box(258, 268, unicode"원부 CID", _cut(c.docCid)),
                '<text x="36" y="384" fill="#fff" fill-opacity=".75" font-size="13">', unicode"담당 평가사 전용 · 양도 불가 · 평가 확정 시 소각",
                "</text></svg>");
        }
        uint256 percent = c.amount == 0 ? 0 : c.repaidAmount * 100 / c.amount;
        return string.concat(svg,
            _box(36, 268, unicode"확정 평가액", string.concat(_commas(c.appraisedValue), unicode"원")), _box(258, 268, unicode"담보인정비율", _ltv(c)),
            _box(36, 346, unicode"신용등급", _grade(c)), _box(258, 346, unicode"금리 · 기간", _terms(c)),
            '<rect x="36" y="430" width="428" height="10" rx="5" fill="#fff" fill-opacity=".2"/><rect x="36" y="430" width="',
            (c.amount == 0 ? 0 : 428 * c.repaidAmount / c.amount).toString(), '" height="10" rx="5" fill="#E0A100"/>',
            '<text x="36" y="466" fill="#fff" fill-opacity=".8" font-size="13">', unicode"상환 ", _commas(c.repaidAmount), unicode"원",
            '</text><text x="464" y="466" fill="#fff" font-size="13" font-weight="700" text-anchor="end">', percent.toString(), "%</text></svg>"
        );
    }

    function _box(uint256 x, uint256 y, string memory label, string memory value) private pure returns (string memory) {
        return string.concat('<rect x="', x.toString(), '" y="', y.toString(), '" width="206" height="66" rx="12" fill="#fff" fill-opacity=".12"/>',
            '<text x="', (x + 16).toString(), '" y="', (y + 26).toString(), '" fill="#fff" fill-opacity=".72" font-size="12">', label,
            '</text><text x="', (x + 16).toString(), '" y="', (y + 52).toString(), '" fill="#fff" font-size="', bytes(value).length > 16 ? "14" : "18",
            '" font-weight="700">', value, "</text>");
    }

    function _palette(Card calldata c) private pure returns (string memory, string memory) {
        if (!c.rwa) return ("#1E4E6E", "#12324A");
        if (c.status == 6) return ("#00843D", "#12324A");
        if (c.status == 3 || c.status == 5) return ("#6B7680", "#2F3940");
        return ("#00A04A", "#006532");
    }

    function _statusLabel(uint8 status) private pure returns (string memory) {
        if (status == 1) return unicode"평가 중";
        if (status == 2) return unicode"약정 심사 중";
        if (status == 3) return unicode"자동심사 거절";
        if (status == 4) return unicode"약정 체결";
        if (status == 5) return unicode"최종 거절";
        if (status == 6) return unicode"상환 완료";
        return "-";
    }

    // Collateral ratio to one decimal place, e.g. 70.0%.
    function _ltv(Card calldata c) private pure returns (string memory) {
        if (c.appraisedValue == 0) return "-";
        uint256 tenths = c.amount * 1000 / c.appraisedValue;
        return string.concat((tenths / 10).toString(), ".", (tenths % 10).toString(), "%");
    }

    function _terms(Card calldata c) private pure returns (string memory) {
        if (c.rateBps == 0) return "-";
        uint256 cents = c.rateBps % 100;
        return string.concat((c.rateBps / 100).toString(), cents < 10 ? ".0" : ".", cents.toString(), unicode"% · ",
            c.termMonths.toString(), unicode"개월");
    }

    function _grade(Card calldata c) private pure returns (string memory) {
        if (bytes(c.creditGrade).length == 0) return "-";
        return c.creditGrade;
    }

    function _commas(uint256 value) private pure returns (string memory) {
        bytes memory digits = bytes(value.toString());
        uint256 n = digits.length;
        bytes memory out = new bytes(n + (n - 1) / 3);
        uint256 j = out.length;
        for (uint256 i = n; i > 0; --i) {
            out[--j] = digits[i - 1];
            if ((n - i) % 3 == 2 && i > 1) out[--j] = ",";
        }
        return string(out);
    }

    // 0x1234ab…cdef
    function _short(bytes32 hash) private pure returns (string memory) {
        bytes memory hex_ = bytes(Strings.toHexString(uint256(hash), 32));
        return string.concat(string(_slice(hex_, 0, 8)), unicode"…", string(_slice(hex_, 62, 66)));
    }

    function _cut(string calldata text) private pure returns (string memory) {
        bytes memory value = bytes(text);
        if (value.length <= 14) return text;
        return string.concat(string(_slice(value, 0, 10)), unicode"…", string(_slice(value, value.length - 4, value.length)));
    }

    function _slice(bytes memory value, uint256 start, uint256 end) private pure returns (bytes memory part) {
        part = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) part[i - start] = value[i];
    }
}
