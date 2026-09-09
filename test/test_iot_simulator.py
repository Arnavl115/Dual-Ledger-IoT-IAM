import base64
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

import iot_simulator


class SimulatorPayloadTests(unittest.TestCase):
    def test_generated_payload_has_a_verifiable_device_signature(self):
        private_key = ec.generate_private_key(ec.SECP256R1())

        with patch.object(iot_simulator.random, "choice", side_effect=["device-1", "unlock"]), \
                patch.object(iot_simulator.time, "time", return_value=1_788_864_000):
            payload = iot_simulator.generate_payload(["device-1"], {"device-1": private_key})

        self.assertEqual(payload["device_id"], "device-1")
        self.assertEqual(payload["action"], "unlock")
        self.assertEqual(payload["timestamp"], "1788864000")
        signed = f'{payload["device_id"]}:{payload["action"]}:{payload["timestamp"]}'.encode()
        private_key.public_key().verify(
            base64.b64decode(payload["signature"]),
            signed,
            ec.ECDSA(hashes.SHA256()),
        )


if __name__ == "__main__":
    unittest.main()
