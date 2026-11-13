# Kokoro voice helper (free, Apache-2.0 model, runs on the GitHub runner's CPU - no card, no account).
# Started once by run.mjs; loads the model one time, then makes one WAV per request.
# Protocol: one JSON line per request on stdin: {"text": "...", "file": "/path/out.wav", "voice": "bm_george", "speed": 0.95, "lang": "en-gb"}
# Reply: one line on stdout: "ok <seconds>" or "err <message>".
import json, os, sys

try:
    import soundfile as sf
    from kokoro_onnx import Kokoro
    d = os.environ.get("KOKORO_DIR", os.path.expanduser("~/kokoro"))
    k = Kokoro(os.path.join(d, "kokoro-v1.0.onnx"), os.path.join(d, "voices-v1.0.bin"))
    print("ready", flush=True)
except Exception as e:  # model missing or install failed: run.mjs falls back to the other voices
    print("err " + str(e).replace("\n", " ")[:300], flush=True)
    sys.exit(0)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        samples, sr = k.create(req["text"], voice=req.get("voice", "am_michael"), speed=float(req.get("speed", 1.0)), lang=req.get("lang", "en-us"))
        # A short calm pause at the end of each scene so scenes do not run into each other.
        pad = int(sr * 0.35)
        import numpy as np
        samples = np.concatenate([samples, np.zeros(pad, dtype=samples.dtype)])
        sf.write(req["file"], samples, sr, format="WAV")  # file name ends in .bin, so the format must be given
        print("ok %.2f" % (len(samples) / sr), flush=True)
    except Exception as e:
        print("err " + str(e).replace("\n", " ")[:300], flush=True)
