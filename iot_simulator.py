import time
import random
import json
import sys
import os
import base64
import getpass

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

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
GATEWAY_BASE_URL = os.environ.get("GATEWAY_BASE_URL", "http://localhost:3000").rstrip("/")
GATEWAY_URL = f"{GATEWAY_BASE_URL}/api/access"
DEVICES_URL = f"{GATEWAY_BASE_URL}/api/devices"
REGISTER_URL = f"{GATEWAY_BASE_URL}/api/devices/register"
KEY_FILE = os.environ.get("SIMULATOR_KEY_FILE", os.path.join(SCRIPT_DIRECTORY, "ecdsa_keys.json"))

DEFAULT_DEVICES = ["SmartLock_FrontDoor", "ServerRack_A", "BioLab_Fridge", "Secure_Gateway_B"]
ACTIONS = ["unlock", "lock", "ping_status"]

def load_keys():
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r") as f:
            return json.load(f)
    return {}

def load_private_key(private_pem):
    return serialization.load_pem_private_key(private_pem.encode(), password=None)

def public_key_pem(private_key):
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()

def same_public_key(left, right):
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    return left.strip().replace("\r\n", "\n") == right.strip().replace("\r\n", "\n")

def sign_payload(private_key, raw_data_string):
    signature = private_key.sign(raw_data_string.encode(), ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(signature).decode()

def file_config_value(file_path, name):
    if os.path.exists(file_path):
        with open(file_path, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None

def config_value(name):
    value = os.environ.get(name) or file_config_value(".env", name)
    if value:
        return value
    if name == "SUPABASE_ANON_KEY":
        return file_config_value(os.path.join("frontend", ".env"), "VITE_SUPABASE_ANON_KEY")
    return None

def validate_admin_access_token(token):
    try:
        payload_segment = token.split(".")[1]
        padding = "=" * (-len(payload_segment) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_segment + padding))
    except Exception as exc:
        raise RuntimeError("SIMULATOR_ACCESS_TOKEN must be a Supabase user JWT, not a service-role key") from exc
    if claims.get("role") != "authenticated" or claims.get("app_metadata", {}).get("role") != "admin":
        raise RuntimeError("Simulator authentication requires an admin user access token")
    if claims.get("exp", 0) <= int(time.time()):
        raise RuntimeError("Simulator access token is expired")
    return token

def load_bearer_token():
    token = config_value("SIMULATOR_ACCESS_TOKEN")
    if token:
        return validate_admin_access_token(token)

    supabase_url = config_value("SUPABASE_URL")
    anon_key = config_value("SUPABASE_ANON_KEY")
    email = config_value("SIMULATOR_EMAIL")
    password = config_value("SIMULATOR_PASSWORD")
    if not supabase_url or not anon_key:
        raise RuntimeError(
            "Set SIMULATOR_ACCESS_TOKEN, or configure SUPABASE_URL and the frontend anon key"
        )
    if sys.stdin.isatty():
        email = email or input("Supabase admin email: ").strip()
        password = password or getpass.getpass("Supabase admin password: ")
    if not email or not password:
        raise RuntimeError("Set SIMULATOR_EMAIL and SIMULATOR_PASSWORD for non-interactive use")

    response = requests.post(
        f"{supabase_url.rstrip('/')}/auth/v1/token?grant_type=password",
        json={"email": email, "password": password},
        headers={"apikey": anon_key, "Authorization": f"Bearer {anon_key}"},
        timeout=10,
    )
    if not response.ok:
        raise RuntimeError(f"Supabase login failed: HTTP {response.status_code} {response.text}")
    return validate_admin_access_token(response.json().get("access_token", ""))

def register_device(device_id, bearer_token):
    response = requests.post(REGISTER_URL, json={
        "id": device_id,
        "simulatorManaged": True
    }, headers={"Authorization": f"Bearer {bearer_token}"}, timeout=120)
    if not response.ok:
        raise RuntimeError(f"Registration failed for {device_id}: HTTP {response.status_code} {response.text}")
    registered = next((device for device in response.json().get("devices", []) if device.get("id") == device_id), None)
    stored_pem = load_keys().get(device_id)
    if not registered or not stored_pem:
        raise RuntimeError(f"Gateway did not provision simulator key material for {device_id}")
    private_key = load_private_key(stored_pem)
    if not same_public_key(registered.get("publicKey"), public_key_pem(private_key)):
        raise RuntimeError(f"Gateway registered a different key for {device_id}")
    print(f"[REGISTERED] {device_id} -> HTTP {response.status_code}")
    return private_key

def fetch_devices(bearer_token):
    response = requests.get(
        DEVICES_URL,
        headers={"Authorization": f"Bearer {bearer_token}"},
        timeout=10,
    )
    if not response.ok:
        raise RuntimeError(f"Device listing failed: HTTP {response.status_code} {response.text}")
    devices = response.json()
    if not isinstance(devices, list):
        raise RuntimeError("Device listing returned an invalid response")
    return devices

def provision_devices(bearer_token):
    stored_keys = load_keys()
    registered_devices = {device["id"]: device for device in fetch_devices(bearer_token)}
    device_keys = {}

    for device_id in DEFAULT_DEVICES:
        existing = registered_devices.get(device_id)
        stored_pem = stored_keys.get(device_id)
        if existing:
            if not stored_pem:
                raise RuntimeError(
                    f"Device {device_id} already exists and is not owned by this simulator key store"
                )
            private_key = load_private_key(stored_pem)
            if not same_public_key(existing.get("publicKey"), public_key_pem(private_key)):
                raise RuntimeError(
                    f"Device {device_id} has a different registered key; refusing to rotate it"
                )
            device_keys[device_id] = private_key
            print(f"[VERIFIED] {device_id} uses the simulator-owned key")
            continue

        private_key = register_device(device_id, bearer_token)
        device_keys[device_id] = private_key

    return device_keys

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

    bearer_token = load_bearer_token()
    provision_devices(bearer_token)
    print()

    while True:
        registered_devices = {device["id"]: device for device in fetch_devices(bearer_token)}
        device_keys = {}
        for device_id, stored_pem in load_keys().items():
            registered = registered_devices.get(device_id)
            if not registered:
                continue
            try:
                private_key = load_private_key(stored_pem)
            except (TypeError, ValueError):
                print(f"[SKIPPED] Invalid simulator key for {device_id}")
                continue
            if same_public_key(registered.get("publicKey"), public_key_pem(private_key)):
                device_keys[device_id] = private_key
        device_ids = list(device_keys)
        if not device_ids:
            print("[WAITING] No simulator-owned devices are currently registered")
            time.sleep(2.0)
            continue
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
    except RuntimeError as exc:
        print(f"\n❌ [FATAL] {exc}", file=sys.stderr)
        sys.exit(1)
