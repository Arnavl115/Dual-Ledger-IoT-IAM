import time
import random
import hashlib
import json

try:
    import requests
except ImportError:
    print("Error: The 'requests' library is not installed.")
    print("Please install it by running: pip install requests")
    exit(1)

GATEWAY_URL = "http://localhost:3000/api/access"
DEVICES_URL = "http://localhost:3000/api/devices"

DEFAULT_DEVICES = ["SmartLock_FrontDoor", "ServerRack_A", "BioLab_Fridge", "Secure_Gateway_B"]
ACTIONS = ["unlock", "lock", "ping_status"]

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

def generate_payload(device_ids):
    device_id = random.choice(device_ids)
    action = random.choice(ACTIONS)
    timestamp = str(int(time.time()))
    
    raw_data_string = f"{device_id}:{action}:{timestamp}"
    signature = hashlib.sha256(raw_data_string.encode()).hexdigest()
    
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
    
    while True:
        device_ids = fetch_dynamic_devices()
        payload = generate_payload(device_ids)
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