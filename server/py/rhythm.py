#!/usr/bin/env python3
"""Beat grid, onsets, silences and a music/speech guess for an audio file. Prints JSON."""
import json, sys
import numpy as np

def main():
    path = sys.argv[1]
    import librosa
    y, sr = librosa.load(path, sr=22050, mono=True)
    dur = len(y) / sr if sr else 0
    if dur < 0.5 or float(np.max(np.abs(y))) < 1e-4:
        print(json.dumps({"averageBpm": 0, "tempoType": "none", "pulseBeats": [], "downbeats": [], "onsets": [], "silences": [[0, round(dur, 3)]] if dur else [], "musicScore": 0, "loudness": [], "detector": {"name": "librosa", "version": librosa.__version__}}))
        return
    hop = 512
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=hop, units="frames")
    tempo = float(np.atleast_1d(tempo)[0])
    bt = librosa.frames_to_time(beats, sr=sr, hop_length=hop)
    # how strongly the audio pulses at one tempo: music with a beat scores high, speech and ambience low
    tg = librosa.feature.tempogram(onset_envelope=oenv, sr=sr, hop_length=hop)
    acm = np.mean(tg, axis=1); acm = acm / (acm[0] + 1e-9)
    lo, hi = int(60 / 200 * sr / hop), int(60 / 60 * sr / hop)
    pulse_peak = float(acm[lo:hi].max()) if hi > lo else 0.0
    # a steady track gets an exact grid: fit beat times to a line, then extend it over the whole file
    if len(bt) >= 8:
        idx = np.arange(len(bt))
        period, phase = np.polyfit(idx, bt, 1)
        resid = bt - (phase + period * idx)
        if float(np.std(resid)) < 0.035 and period > 0.2:
            onset_t = librosa.frames_to_time(np.arange(len(oenv)), sr=sr, hop_length=hop)
            # frame timestamps sit at the start of the analysis hop; shift the grid onto the real attacks
            cand = np.linspace(-0.06, 0.06, 25)
            def score(off):
                g = np.arange(phase + off - period * np.floor((phase + off) / period), dur, period)
                return float(np.interp(g, onset_t, oenv).sum())
            phase = phase + float(cand[int(np.argmax([score(c) for c in cand]))]) - 0.02  # onset strength peaks about one hop after the attack
            first = phase - period * np.floor(phase / period)
            bt = np.arange(first, dur - 0.02, period)
            beats = np.clip(librosa.time_to_frames(bt, sr=sr, hop_length=hop), 0, len(oenv) - 1)
            tempo = 60.0 / period
    mx = float(oenv.max()) or 1.0
    strength = [float(oenv[min(int(b), len(oenv) - 1)] / mx) for b in beats]
    # beat regularity tells music with a pulse from speech or ambience
    iv = np.diff(bt)
    reg = float(1.0 - min(1.0, np.std(iv) / (np.mean(iv) + 1e-9))) if len(iv) > 3 else 0.0
    # autocorrelation peak of the onset envelope at the beat period
    ac = librosa.autocorrelate(oenv, max_size=len(oenv) // 2) if len(oenv) > 16 else np.array([1.0])
    period = int(round(60.0 / tempo * sr / hop)) if tempo > 0 else 0
    pulse = float(ac[period] / (ac[0] + 1e-9)) if 0 < period < len(ac) else 0.0
    # downbeats: assume 4/4 and pick the phase whose beats carry the most low-frequency energy
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    low = S[: max(4, int(150 / (sr / 2048)))].sum(axis=0)
    best, best_e = 0, -1.0
    for ph in range(4):
        idx = beats[ph::4]
        e = float(np.mean([low[min(int(i), len(low) - 1)] for i in idx])) if len(idx) else 0.0
        if e > best_e: best, best_e = ph, e
    down = [[round(float(bt[i]), 3), round(strength[i], 3)] for i in range(best, len(bt), 4)]
    on = librosa.onset.onset_detect(onset_envelope=oenv, sr=sr, hop_length=hop, units="frames", backtrack=False)
    onsets = [[round(float(librosa.frames_to_time(o, sr=sr, hop_length=hop)), 3), round(float(oenv[min(int(o), len(oenv) - 1)] / mx), 3)] for o in on]
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    db = librosa.amplitude_to_db(rms, ref=np.max)
    quiet = db < -38
    sil, start = [], None
    times = librosa.frames_to_time(np.arange(len(db)), sr=sr, hop_length=hop)
    for i, q in enumerate(quiet):
        if q and start is None: start = times[i]
        if (not q or i == len(quiet) - 1) and start is not None:
            if times[i] - start >= 0.35: sil.append([round(float(start), 3), round(float(times[i]), 3)])
            start = None
    flat = float(np.mean(librosa.feature.spectral_flatness(y=y)))
    music = max(0.0, min(1.0, (pulse_peak - 0.36) / 0.3))
    # coarse loudness curve, 10 values per second, 0..1
    step = max(1, int(sr / hop / 10))
    loud = [round(float(max(0.0, min(1.0, (v + 60) / 60))), 3) for v in db[::step]]
    print(json.dumps({
        "averageBpm": round(tempo, 1), "tempoType": "steady" if reg > 0.9 else ("variable" if reg > 0.6 else "none"),
        "pulseBeats": [[round(float(t), 3), round(s, 3)] for t, s in zip(bt, strength)], "downbeats": down, "onsets": onsets, "silences": sil,
        "musicScore": round(music, 3), "pulseClarity": round(pulse_peak, 3), "beatRegularity": round(reg, 3), "spectralFlatness": round(flat, 4), "loudness": loud,
        "detector": {"name": "librosa", "version": librosa.__version__},
    }))

if __name__ == "__main__":
    main()
