"""Audio-based empathy and tone evaluation using prosodic analysis"""
import librosa
import numpy as np
from pathlib import Path
from typing import Dict, List, Any, Tuple
from src.recording.session_types import SessionRecording


class AudioEmpathyEvaluator:
    """Evaluates empathy and tone from audio prosodic features"""
    
    def __init__(self, sample_rate: int = 24000):
        """
        Initialize audio evaluator
        
        Args:
            sample_rate: Expected sample rate of audio files
        """
        self.sample_rate = sample_rate
    
    def evaluate(self, session_recording: SessionRecording) -> Dict[str, Any]:
        """
        Evaluate empathy and tone from audio

        Args:
            session_recording: Recording with audio file and transcript

        Returns:
            Dictionary with audio-based scores and feedback
        """
        audio_file = Path(session_recording.audio_file)

        if not audio_file.exists():
            return {
                'score': 0.0,
                'reason': 'Audio file not found',
                'features': {},
                'components': {},
            }

        # Load audio
        try:
            audio, sr = librosa.load(str(audio_file), sr=self.sample_rate)
        except Exception as e:
            return {
                'score': 0.0,
                'reason': f'Error loading audio: {e}',
                'features': {},
                'components': {},
            }

        # Entire file is agent audio (right channel extracted upstream)
        agent_segments = [audio]

        if not agent_segments:
            return {
                'score': 0.0,
                'reason': 'No agent audio segments found',
                'features': {},
                'components': {},
            }

        # Analyze prosodic features
        features = self._analyze_prosodic_features(agent_segments, sr)

        # Calculate empathy score from features
        score, components = self._calculate_empathy_score(features)

        # Generate feedback
        feedback = self._generate_feedback(features, score)

        return {
            'score': score,
            'reason': feedback,
            'features': features,
            'components': components,
        }
    
    def _analyze_prosodic_features(
        self, 
        segments: List[np.ndarray], 
        sr: int
    ) -> Dict[str, float]:
        """Analyze prosodic features across all agent segments"""
        all_features = {
            'pitch_mean': [],
            'pitch_std': [],
            'energy_mean': [],
            'energy_std': [],
            'zero_crossing_rate': [],
            'spectral_centroid': [],
            'speaking_rate': []
        }
        
        for segment in segments:
            if len(segment) < sr * 0.1:  # Skip very short segments (< 100ms)
                continue
            
            # Pitch analysis
            pitches, magnitudes = librosa.piptrack(
                y=segment, 
                sr=sr,
                fmin=75,   # Male: ~85Hz, Female: ~165Hz, use lower bound
                fmax=400   # Upper bound for human speech
            )
            
            # Get non-zero pitches
            pitch_values = pitches[pitches > 0]
            if len(pitch_values) > 0:
                all_features['pitch_mean'].append(np.mean(pitch_values))
                all_features['pitch_std'].append(np.std(pitch_values))
            
            # Energy (RMS)
            rms = librosa.feature.rms(y=segment)[0]
            all_features['energy_mean'].append(np.mean(rms))
            all_features['energy_std'].append(np.std(rms))
            
            # Zero crossing rate (voice quality)
            zcr = librosa.feature.zero_crossing_rate(segment)[0]
            all_features['zero_crossing_rate'].append(np.mean(zcr))
            
            # Spectral centroid (brightness of voice)
            spec_cent = librosa.feature.spectral_centroid(y=segment, sr=sr)[0]
            all_features['spectral_centroid'].append(np.mean(spec_cent))
            
            # Speaking rate (tempo)
            try:
                tempo, _ = librosa.beat.beat_track(y=segment, sr=sr)
                all_features['speaking_rate'].append(tempo)
            except Exception:  # nosec B110
                pass
        
        # Aggregate features
        aggregated = {}
        for key, values in all_features.items():
            if values:
                aggregated[f'{key}_avg'] = float(np.mean(values))
                aggregated[f'{key}_variation'] = float(np.std(values))
        
        return aggregated
    
    def _calculate_empathy_score(self, features: Dict[str, float]) -> Tuple[float, Dict[str, Any]]:
        """Calculate empathy score from prosodic features.

        Returns:
            Tuple of (final_score, components) where components is a dict
            mapping component name to {score, weight}.
        """
        if not features:
            return 0.0, {}

        score_components = []

        # 1. Pitch variation (0.25 weight)
        # Moderate variation shows engagement (not too flat, not too erratic)
        pitch_std = features.get('pitch_std_avg', 0)
        if pitch_std > 0:
            # Ideal: 20-40 Hz variation
            if 20 <= pitch_std <= 40:
                pitch_score = 1.0
            elif pitch_std < 20:
                pitch_score = pitch_std / 20  # Too flat
            else:
                pitch_score = max(0, 1.0 - (pitch_std - 40) / 60)  # Too variable
            score_components.append(('pitch_variation', pitch_score, 0.25))

        # 2. Energy/Volume (0.20 weight)
        # Moderate, controlled energy shows patience
        energy_mean = features.get('energy_mean_avg', 0)
        energy_std = features.get('energy_std_avg', 0)

        if energy_mean > 0:
            # Ideal: moderate energy (0.01-0.05), low variation
            if 0.01 <= energy_mean <= 0.05:
                energy_score = 1.0
            else:
                energy_score = max(0, 1.0 - abs(energy_mean - 0.03) / 0.05)

            # Penalize high variation (inconsistent volume)
            if energy_std > 0.02:
                energy_score *= 0.8

            score_components.append(('energy', energy_score, 0.20))

        # 3. Speaking rate (0.20 weight)
        # Slower = more patient and clear
        rate = features.get('speaking_rate_avg', 120)

        # Ideal: 100-140 BPM (words per minute roughly 2/3 of BPM)
        if 100 <= rate <= 140:
            rate_score = 1.0
        elif rate < 100:
            rate_score = 0.9  # Very slow, might be too hesitant
        else:
            rate_score = max(0, 1.0 - (rate - 140) / 80)  # Penalize rushing

        score_components.append(('speaking_rate', rate_score, 0.20))

        # 4. Voice quality (0.20 weight)
        # Spectral features indicate warmth
        zcr = features.get('zero_crossing_rate_avg', 0)
        spec_cent = features.get('spectral_centroid_avg', 0)

        # Lower ZCR and moderate spectral centroid = warmer voice
        if zcr > 0:
            # Ideal: 0.05-0.15
            quality_score = 1.0 if 0.05 <= zcr <= 0.15 else 0.7
            score_components.append(('voice_quality', quality_score, 0.20))

        # 5. Consistency (0.15 weight)
        # Low variation across turns shows professional control
        pitch_variation = features.get('pitch_std_variation', 0)
        energy_variation = features.get('energy_mean_variation', 0)

        consistency_score = 1.0
        if pitch_variation > 20:
            consistency_score -= 0.3
        if energy_variation > 0.01:
            consistency_score -= 0.2

        consistency_score = max(0, consistency_score)
        score_components.append(('consistency', consistency_score, 0.15))

        # Calculate weighted average
        if score_components:
            total_weighted = sum(score * weight for _, score, weight in score_components)
            total_weight = sum(weight for _, _, weight in score_components)
            final_score = total_weighted / total_weight if total_weight > 0 else 0.0
        else:
            final_score = 0.0

        # Build components dict for frontend display
        components = {}
        for name, score_val, weight in score_components:
            components[name] = {
                'score': round(score_val, 2),
                'weight': weight,
            }

        return final_score, components
    
    def _generate_feedback(self, features: Dict[str, float], score: float) -> str:
        """Generate human-readable feedback from features"""
        feedback_parts = []
        
        # Pitch feedback
        pitch_std = features.get('pitch_std_avg', 0)
        if pitch_std < 15:
            feedback_parts.append("Voice sounds somewhat monotone - try varying pitch to show engagement")
        elif pitch_std > 50:
            feedback_parts.append("Voice shows high variation - may come across as anxious or uncertain")
        else:
            feedback_parts.append("Good pitch variation showing natural engagement")
        
        # Energy feedback
        energy_mean = features.get('energy_mean_avg', 0)
        if energy_mean < 0.01:
            feedback_parts.append("Speaking volume is low - project confidence")
        elif energy_mean > 0.06:
            feedback_parts.append("Speaking volume is high - consider softer tone for empathy")
        else:
            feedback_parts.append("Appropriate volume and energy level")
        
        # Rate feedback
        rate = features.get('speaking_rate_avg', 120)
        if rate > 150:
            feedback_parts.append("Speaking pace is fast - slow down to show patience")
        elif rate < 90:
            feedback_parts.append("Speaking pace is very slow - may lose customer attention")
        else:
            feedback_parts.append("Good speaking pace - clear and measured")
        
        # Overall assessment
        if score >= 0.8:
            overall = "Excellent vocal empathy and professional tone."
        elif score >= 0.6:
            overall = "Good vocal delivery with room for minor improvements."
        elif score >= 0.4:
            overall = "Adequate tone but significant improvements needed in vocal empathy."
        else:
            overall = "Voice delivery needs substantial work on empathy and professionalism."
        
        return overall + " " + " ".join(feedback_parts)
