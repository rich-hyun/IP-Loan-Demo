import unittest
from unittest.mock import Mock, patch
from web3.exceptions import Web3RPCError
from server import chain


class MediaCapabilityTest(unittest.TestCase):
    def probe(self, failure):
        web3, manager = Mock(), Mock()
        web3.eth.block_number = 10
        manager.address = '0x' + '12' * 20
        manager.functions.contractVersion().call.return_value = 2
        manager.functions.tokenMediaVersion().call.side_effect = failure
        manager.functions.getRoleMemberCount().call.return_value = 0
        with patch.object(chain, 'MANAGER_ADDRESS', manager.address), patch.object(chain, '_manager', return_value=(web3,manager)):
            return chain.config()

    def test_legacy_empty_revert_is_supported_without_hiding_rpc_outages(self):
        old = Web3RPCError('legacy', rpc_response={'error': {'code': -32000, 'message': 'Transaction reverted without a reason string', 'data': '0x'}})
        self.assertEqual(self.probe(old)['tokenMediaVersion'], 0)
        outage = Web3RPCError('offline', rpc_response={'error': {'code': -32000, 'message': 'node unavailable'}})
        with self.assertRaises(chain.ChainError):
            self.probe(outage)


if __name__ == '__main__':
    unittest.main()
