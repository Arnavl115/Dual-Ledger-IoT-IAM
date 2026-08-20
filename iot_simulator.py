import time
import random
import json
import sys
import os
import base64

# Ensure emoji output renders correctly on Windows (cp1252 console default)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

try:
    import requests
except ImportError:
    print("Error: The 'requests' library is not installed.")
    print("Please install it by running: pip install requests")
    exit(1)

try:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import hashes, serialization
except ImportError:
    print("Error: The 'cryptography' library is not installed.")
    print("Please install it by running: pip install cryptography")
    exit(1)

GATEWAY_URL = "http://localhost:3000/api/access"
DEVICES_URL = "http://localhost:3000/api/devices"
REGISTER_URL = "http://localhost:3000/api/devices/register"
KEY_FILE = "ecdsa_keys.json"

DEFAULT_DEVICES = ["SmartLock_FrontDoor", "ServerRack_A", "BioLab_Fridge", "Secure_Gateway_B"]
ACTIONS = ["unlock", "lock", "ping_status"]

def load_or_create_key(device_id):
    keys = {}
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r") as f:
            keys = json.load(f)

    if device_id not in keys:
        private_key = ec.generate_private_key(ec.SECP256R1())
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).decode()
        keys[device_id] = private_pem
        with open(KEY_FILE, "w") as f:
            json.dump(keys, f, indent=2)
    else:
        private_key = serialization.load_pem_private_key(keys[device_id].encode(), password=None)

    return private_key

def public_key_pem(private_key):
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()

def sign_payload(private_key, raw_data_string):
    signature = private_key.sign(raw_data_string.encode(), ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(signature).decode()

def load_bearer_token():
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if token:
        return token
    if os.path.exists(".env"):
        with open(".env", "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None

def register_device(device_id, private_key, bearer_token):
    headers = {"Authorization": f"Bearer {bearer_token}"} if bearer_token else {}
    try:
        response = requests.post(REGISTER_URL, json={
            "id": device_id,
            "publicKey": public_key_pem(private_key)
        }, headers=headers, timeout=2)
        print(f"[REGISTERED] {device_id} -> HTTP {response.status_code}")
    except Exception as e:
        print(f"   ⚠️ [WARNING] Registration failed for {device_id}: {e}")

def fetch_dynamic_devices():
    try:
        response = requests.get(DEVICES_URL, timeout=1.5)
        if response.status_code == 200:
            devices = response.json()
            device_ids = [d['id'] for d in devices]
            if device_ids:
                return device_ids
    except Exception:
        pass
    return DEFAULT_DEVICES

def generate_payload(device_ids, device_keys):
    device_id = random.choice(device_ids)
    action = random.choice(ACTIONS)
    timestamp = str(int(time.time()))

    raw_data_string = f"{device_id}:{action}:{timestamp}"
    signature = sign_payload(device_keys[device_id], raw_data_string)

    payload = {
        "device_id": device_id,
        "action": action,
        "timestamp": timestamp,
        "signature": signature
    }
    return payload

def run_simulator():
    print("=========================================")
    print("🚀 IoT Edge Simulator (Dynamic Integration)")
    print(f"📡 API Access Endpoint:  {GATEWAY_URL}")
    print(f"📡 Devices Sync Endpoint: {DEVICES_URL}")
    print("=========================================\n")

    sleep_time = 2.0

    device_keys = {}
    bearer_token = load_bearer_token()
    for device_id in DEFAULT_DEVICES:
        private_key = load_or_create_key(device_id)
        device_keys[device_id] = private_key
        register_device(device_id, private_key, bearer_token)
    print()

    while True:
        device_ids = fetch_dynamic_devices()
        for device_id in device_ids:
            if device_id not in device_keys:
                private_key = load_or_create_key(device_id)
                device_keys[device_id] = private_key
                register_device(device_id, private_key, bearer_token)
        payload = generate_payload(device_ids, device_keys)
        print(f"[GENERATED] {payload['device_id']} requesting '{payload['action']}'...")
        
        try:
            response = requests.post(GATEWAY_URL, json=payload, timeout=2)
            print(f"[GATEWAY RESPONSE] Status: {response.status_code} | Body: {response.text}")
            
            # Read gateway stress status feedback to adjust pacing dynamically
            if response.status_code in [200, 401, 403]:
                try:
                    res_body = response.json()
                    is_stress = res_body.get('isStressTesting', False)
                    if is_stress:
                        sleep_time = 0.1  # Fast transmission under stress test
                    else:
                        sleep_time = 2.0  # Standard pacing interval
                except Exception:
                    sleep_time = 2.0
            else:
                sleep_time = 2.0
                
        except requests.exceptions.ConnectionError:
            print(f"   ❌ [ERROR] Connection Refused. The API Gateway at {GATEWAY_URL} is offline.")
            sleep_time = 2.0
        except Exception as e:
            print(f"   ⚠️ [WARNING] Unexpected error: {e}")
            sleep_time = 2.0
            
        print(f"Pacing delay: {sleep_time}s")
        print("-" * 40)
        time.sleep(sleep_time)

if __name__ == "__main__":
    try:
        run_simulator()
    except KeyboardInterrupt:
        print("\n\n🛑 Simulator stopped by user. Goodbye!")