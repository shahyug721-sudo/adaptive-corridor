"""Audio feature extraction for siren classification.

Two representations, for the two model families:

* `mel_spectrogram`  -> log-Mel, 128 x T, for the CNN and CNN+BiLSTM.
* `feature_vector`   -> MFCC statistics plus the spectral/temporal battery from
                        Jayakumar et al. (Electronics 13(19) 3873, 2024), for
                        the SVM / Random Forest baselines.

WHY NOT A FIXED FREQUENCY
-------------------------
The obvious implementation -- band-pass around the siren frequency and threshold
the energy -- fails on the one signal it most needs to reject. A wail siren
sweeps roughly 500-1800 Hz at about 0.2-1.5 Hz; a yelp does the same faster; a
two-tone alternates between discrete pitches. A car horn is a *steady* harmonic
stack sitting in the same band at a similar level. Energy-in-band cannot
separate them, so a threshold detector fires on the horn every time.

What separates them is the trajectory of energy through the time-frequency
plane: sirens move, horns do not. That is why the representation here is a
spectrogram rather than a scalar, and why the classical baseline includes
*spectral flux* (frame-to-frame spectral change) and the standard deviation of
the spectral centroid -- both of which measure movement rather than level.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

try:
    import librosa
except ImportError as exc:  # pragma: no cover - environment dependent
    raise ImportError(
        "librosa is required for feature extraction. Install with:\n"
        "    pip install librosa soundfile"
    ) from exc


SAMPLE_RATE = 22050
CLIP_SECONDS = 3.0
N_MELS = 128
N_FFT = 1024
HOP = 512
N_MFCC = 40


@dataclass(frozen=True)
class AudioConfig:
    sample_rate: int = SAMPLE_RATE
    clip_seconds: float = CLIP_SECONDS
    n_mels: int = N_MELS
    n_fft: int = N_FFT
    hop_length: int = HOP
    n_mfcc: int = N_MFCC

    @property
    def n_samples(self) -> int:
        return int(round(self.sample_rate * self.clip_seconds))

    @property
    def n_frames(self) -> int:
        return 1 + self.n_samples // self.hop_length


def load_clip(path: str, cfg: AudioConfig = AudioConfig(), offset: float = 0.0) -> np.ndarray:
    """Load, resample to mono, and fix to exactly `clip_seconds`.

    Clips in the source dataset run 3-15 s. Fixing the length is what lets the
    CNN take a fixed input; the alternative -- padding everything to the longest
    clip -- would leave most inputs mostly silence and let the model learn clip
    length as a shortcut for class.
    """
    y, _ = librosa.load(path, sr=cfg.sample_rate, mono=True, offset=offset,
                        duration=cfg.clip_seconds)
    return fix_length(y, cfg.n_samples)


def fix_length(y: np.ndarray, n: int) -> np.ndarray:
    if len(y) == n:
        return y
    if len(y) > n:
        return y[:n]
    return np.pad(y, (0, n - len(y)), mode="constant")


def mel_spectrogram(y: np.ndarray, cfg: AudioConfig = AudioConfig()) -> np.ndarray:
    """Log-Mel spectrogram in dB, shape (n_mels, n_frames)."""
    mel = librosa.feature.melspectrogram(
        y=y, sr=cfg.sample_rate, n_fft=cfg.n_fft,
        hop_length=cfg.hop_length, n_mels=cfg.n_mels, power=2.0,
    )
    return librosa.power_to_db(mel, ref=np.max)


def normalise_spec(spec: np.ndarray) -> np.ndarray:
    """Per-clip standardisation.

    Per-clip rather than per-corpus: recording level varies with distance and
    equipment, and it carries no class information we want the model to use.
    Standardising per corpus would leave loudness as a usable shortcut, and the
    siren clips are systematically louder than the road noise.
    """
    mu, sd = spec.mean(), spec.std()
    return (spec - mu) / (sd + 1e-8)


# ------------------------------------------------------------------ battery

def feature_vector(y: np.ndarray, cfg: AudioConfig = AudioConfig()) -> np.ndarray:
    """MFCC statistics plus the spectral/temporal battery (P2).

    Each frame-wise feature is summarised by mean and standard deviation. The
    standard deviations matter as much as the means here: a siren's centroid
    *moves* and a horn's does not, so the spread is often the discriminative
    half.
    """
    sr, n_fft, hop = cfg.sample_rate, cfg.n_fft, cfg.hop_length
    stft = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))

    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=cfg.n_mfcc, n_fft=n_fft, hop_length=hop)
    d1 = librosa.feature.delta(mfcc)
    d2 = librosa.feature.delta(mfcc, order=2)

    centroid = librosa.feature.spectral_centroid(S=stft, sr=sr)
    bandwidth = librosa.feature.spectral_bandwidth(S=stft, sr=sr)
    rolloff = librosa.feature.spectral_rolloff(S=stft, sr=sr, roll_percent=0.85)
    flatness = librosa.feature.spectral_flatness(S=stft)
    contrast = librosa.feature.spectral_contrast(S=stft, sr=sr)
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=n_fft, hop_length=hop)
    rms = librosa.feature.rms(S=stft, frame_length=n_fft, hop_length=hop)
    # spectral flux: frame-to-frame change, the direct measure of "does the
    # spectrum move?" which is what separates a sweep from a steady tone
    flux = np.diff(stft, axis=1)
    flux = np.sqrt((flux ** 2).sum(axis=0))[None, :]

    parts = [mfcc, d1, d2, centroid, bandwidth, rolloff, flatness, contrast, zcr, rms, flux]
    stats = []
    for p in parts:
        stats.append(p.mean(axis=1))
        stats.append(p.std(axis=1))
    return np.concatenate(stats).astype(np.float32)


def feature_names(cfg: AudioConfig = AudioConfig()) -> list[str]:
    """Names aligned with `feature_vector`, for feature-importance reporting."""
    names: list[str] = []
    for tag, count in [
        ("mfcc", cfg.n_mfcc), ("mfcc_d1", cfg.n_mfcc), ("mfcc_d2", cfg.n_mfcc),
        ("centroid", 1), ("bandwidth", 1), ("rolloff", 1), ("flatness", 1),
        ("contrast", 7), ("zcr", 1), ("rms", 1), ("flux", 1),
    ]:
        for stat in ("mean", "std"):
            for i in range(count):
                names.append(f"{tag}[{i}]_{stat}" if count > 1 else f"{tag}_{stat}")
    return names


def describe() -> str:
    cfg = AudioConfig()
    y = np.zeros(cfg.n_samples, dtype=np.float32)
    return (
        f"sample_rate={cfg.sample_rate} clip={cfg.clip_seconds}s "
        f"mel={cfg.n_mels}x{mel_spectrogram(y).shape[1]} "
        f"vector_dim={feature_vector(y).shape[0]}"
    )
