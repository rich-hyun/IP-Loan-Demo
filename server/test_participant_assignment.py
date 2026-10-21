"""Assignment policy tests; no DB or RPC calls."""
import os
import unittest
from unittest.mock import patch
from server import chain

E1 = "0x1111111111111111111111111111111111111111"
E2 = "0x2222222222222222222222222222222222222222"
B1 = "0x3333333333333333333333333333333333333333"
B2 = "0x4444444444444444444444444444444444444444"
R1 = "0x5555555555555555555555555555555555555555"


class ParticipantAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"IPLOAN_ASSIGNMENT_EVALUATOR": "", "IPLOAN_ASSIGNMENT_BANK": "", "IPLOAN_ASSIGNMENT_BY_BORROWER": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.cfg = {"roleMembers": {"EVALUATOR_ROLE": [E1, E2], "BANK_ROLE": [B1, B2]}}

    def test_random_selection_uses_registered_holders(self):
        with patch.object(chain.secrets, "choice", side_effect=lambda pool: pool[-1]):
            self.assertEqual(E2, chain.select_evaluator(self.cfg, R1))
            self.assertEqual(B2, chain.select_bank(self.cfg, E1, R1))

    def test_specific_addresses_are_selected_only_when_registered(self):
        with patch.dict(os.environ, {"IPLOAN_ASSIGNMENT_EVALUATOR": E2, "IPLOAN_ASSIGNMENT_BANK": B1}):
            self.assertEqual(E2, chain.select_evaluator(self.cfg, R1))
            self.assertEqual(B1, chain.select_bank(self.cfg, E2, R1))

    def test_preferred_unregistered_address_fails_instead_of_falling_back(self):
        with patch.dict(os.environ, {"IPLOAN_ASSIGNMENT_EVALUATOR": B1, "IPLOAN_ASSIGNMENT_BANK": E1}):
            with self.assertRaises(chain.ChainError):
                chain.select_evaluator(self.cfg, R1)
            with self.assertRaises(chain.ChainError):
                chain.select_bank(self.cfg, E2, R1)

    def test_per_borrower_assignment_overrides_global_preference(self):
        other = "0x6666666666666666666666666666666666666666"
        with patch.dict(os.environ, {"IPLOAN_ASSIGNMENT_EVALUATOR": E2, "IPLOAN_ASSIGNMENT_BANK": B2,
                                     "IPLOAN_ASSIGNMENT_BY_BORROWER": f"{R1.upper().replace('0X', '0x')}={E1}/{B1}"}):
            self.assertEqual(E1, chain.select_evaluator(self.cfg, R1))
            self.assertEqual(B1, chain.select_bank(self.cfg, E1, R1))
            self.assertEqual(E2, chain.select_evaluator(self.cfg, other))
            self.assertEqual(B2, chain.select_bank(self.cfg, E2, other))
        with patch.dict(os.environ, {"IPLOAN_ASSIGNMENT_BY_BORROWER": f"{R1}={B1}/{B2}"}):
            with self.assertRaises(chain.ChainError):
                chain.select_evaluator(self.cfg, R1)

    def test_borrower_and_evaluator_are_never_their_own_reviewers(self):
        cfg = {"roleMembers": {"EVALUATOR_ROLE": [R1, E1], "BANK_ROLE": [E1, R1, B1]}}
        for _ in range(20):
            self.assertEqual(E1, chain.select_evaluator(cfg, R1))
            self.assertEqual(B1, chain.select_bank(cfg, E1, R1))
        with patch.dict(os.environ, {"IPLOAN_ASSIGNMENT_BANK": E1}):
            with self.assertRaises(chain.ChainError):
                chain.select_bank(cfg, E1, R1)

    def test_empty_pools_are_rejected(self):
        empty = {"roleMembers": {"EVALUATOR_ROLE": [], "BANK_ROLE": [E1]}}
        with self.assertRaises(chain.ChainError):
            chain.select_evaluator(empty, R1)
        with self.assertRaises(chain.ChainError):
            chain.select_bank(empty, E1, R1)

    def test_eligibility_matches_contract_70_percent_rule(self):
        self.assertTrue(chain.eligible(70, 100))
        self.assertFalse(chain.eligible(70, 99))
        self.assertFalse(chain.eligible(71, 100))


if __name__ == "__main__":
    unittest.main()
