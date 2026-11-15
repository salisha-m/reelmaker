#!/usr/bin/env python3
"""Transcribe an audio file with word timestamps. Prints one JSON object on stdout."""
import json, sys, os

def main():
    audio, model_dir = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None
    from faster_whisper import WhisperModel
    model = WhisperModel(model_dir, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")))
    import soundfile as sf
    import numpy as np
    data, sr = sf.read(audio, dtype="float32", always_2d=True)
    data = data.mean(axis=1)
    if sr != 16000:
        import librosa
        data = librosa.resample(data, orig_sr=sr, target_sr=16000)
    segments, info = model.transcribe(np.ascontiguousarray(data), language=language, word_timestamps=True, vad_filter=True,
                                      vad_parameters=dict(min_silence_duration_ms=350), beam_size=5, condition_on_previous_text=False)
    out = []
    for i, s in enumerate(segments):
        words = [{"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3), "probability": round(w.probability, 3)} for w in (s.words or []) if w.word.strip()]
        if not words:
            continue
        out.append({"id": i, "start": round(words[0]["start"], 3), "end": round(words[-1]["end"], 3), "text": s.text.strip(), "words": words, "speaker": 0})
        sys.stderr.write("progress %.3f\n" % min(1.0, s.end / max(info.duration, 0.01))); sys.stderr.flush()
    print(json.dumps({"language": info.language, "segments": out, "total_duration": round(info.duration, 3)}))

if __name__ == "__main__":
    main()
