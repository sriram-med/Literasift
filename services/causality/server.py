"""Optional inference service for the BioBERT causality classifier (drug-causality-bert-v2, Apache-2.0, PrashantRGore).

LiteraSift calls this service only when CAUSALITY_ENDPOINT and CAUSALITY_TOKEN are set. The text it receives has already had patient-identifying
data redacted. The answer is stored as a machine suggestion; it is never a reviewer decision and is not a WHO-UMC or Naranjo category.

Run:   pip install -r requirements.txt && CAUSALITY_TOKEN=... python server.py
Model: MODEL_DIR (a local folder with the weights) or, by default, the Hugging Face model PrashantRGore/drug-causality-bert-v2-model.
Class 1 means related / causal, class 0 not related (as in the original project).
"""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL = os.environ.get("MODEL_DIR") or "PrashantRGore/drug-causality-bert-v2-model"
TOKEN = os.environ.get("CAUSALITY_TOKEN", "")
if len(TOKEN) < 24:
    raise SystemExit("Set CAUSALITY_TOKEN to at least 24 characters.")
HOST, PORT = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8791"))

tokenizer = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForSequenceClassification.from_pretrained(MODEL).eval()


def predict(text: str) -> float:
    inputs = tokenizer(text, return_tensors="pt", truncation=True, padding=True, max_length=128)
    with torch.no_grad():
        probs = torch.softmax(model(**inputs).logits, dim=-1)[0]
    return float(probs[1])


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True, "model": MODEL}) if self.path == "/health" else self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/predict":
            return self._send(404, {"error": "not found"})
        supplied = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
        if not hmac.compare_digest(supplied.encode(), TOKEN.encode()):
            return self._send(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 20000:
                return self._send(413, {"error": "too large"})
            text = str(json.loads(self.rfile.read(length)).get("text", "")).strip()
        except Exception:
            return self._send(400, {"error": "bad request"})
        if len(text) < 5:
            return self._send(400, {"error": "text required"})
        p = predict(text)
        self._send(200, {"label": "causal" if p >= 0.5 else "non-causal", "probability": round(p, 4), "model": MODEL})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
