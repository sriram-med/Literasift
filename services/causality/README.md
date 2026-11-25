# BioBERT causality service (optional)

See the docstring in server.py. Start it with CAUSALITY_TOKEN set, then give LiteraSift CAUSALITY_ENDPOINT=https://your-host/predict and the same token as CAUSALITY_TOKEN. Keep it on a private network or behind HTTPS. Not tested in this repository (it needs torch and the model weights).
