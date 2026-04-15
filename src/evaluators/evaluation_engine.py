"""Evaluation engine for processing and scoring training sessions"""
import json
import logging
import asyncio
from pathlib import Path
from typing import Dict, List, Any
from datetime import datetime

logger = logging.getLogger(__name__)
from src.recording.session_types import SessionRecording
from src.evaluators.rubric import (
    EmpathyScoreEvaluator,
    PolicyKnowledgeEvaluator,
    ResolutionPathEvaluator,
    CommunicationClarityEvaluator,
    ComplianceEvaluator
)
from src.evaluators.audio_empathy_evaluator import AudioEmpathyEvaluator


class EvaluationReport:
    """Detailed evaluation report for a training session"""
    
    def __init__(self, session_recording: SessionRecording):
        self.session_id = session_recording.session_id
        self.scenario_name = session_recording.scenario_name
        self.scores: Dict[str, Dict[str, Any]] = {}
        self.overall_score: float = 0.0
        self.evaluation_timestamp = datetime.now().isoformat()
        
    def add_metric_score(self, metric_name: str, score: float, 
                        reason: str, weight: float = 1.0):
        """Add a metric score to the report"""
        self.scores[metric_name] = {
            "score": score,
            "reason": reason,
            "weight": weight,
            "weighted_score": score * weight
        }
    
    def calculate_overall_score(self):
        """Calculate weighted overall score"""
        if not self.scores:
            self.overall_score = 0.0
            return
        
        total_weighted = sum(s["weighted_score"] for s in self.scores.values())
        total_weight = sum(s["weight"] for s in self.scores.values())
        
        self.overall_score = (total_weighted / total_weight) if total_weight > 0 else 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert report to dictionary"""
        return {
            "session_id": self.session_id,
            "scenario_name": self.scenario_name,
            "evaluation_timestamp": self.evaluation_timestamp,
            "overall_score": round(self.overall_score * 100, 2),
            "overall_grade": self._get_grade(self.overall_score),
            "metric_scores": {
                name: {
                    "score": round(data["score"] * 100, 2),
                    "grade": self._get_grade(data["score"]),
                    "reason": data["reason"],
                    "weight": data["weight"]
                }
                for name, data in self.scores.items()
            }
        }
    
    def _get_grade(self, score: float) -> str:
        """Convert score to letter grade"""
        if score >= 0.9:
            return "A"
        elif score >= 0.8:
            return "B"
        elif score >= 0.7:
            return "C"
        elif score >= 0.6:
            return "D"
        else:
            return "F"
    
    def display(self):
        """Display formatted report"""
        print("\n" + "="*70)
        print(f"EVALUATION REPORT - Session {self.session_id}")
        print(f"Scenario: {self.scenario_name}")
        print("="*70 + "\n")
        
        print(f"Overall Score: {self.overall_score*100:.1f}% (Grade: {self._get_grade(self.overall_score)})")
        print("\n" + "-"*70)
        print("\nDetailed Metrics:\n")
        
        for metric_name, data in self.scores.items():
            score_pct = data["score"] * 100
            grade = self._get_grade(data["score"])
            print(f"{metric_name}:")
            print(f"  Score: {score_pct:.1f}% (Grade: {grade})")
            print(f"  Weight: {data['weight']:.0%}")
            print(f"  Feedback: {data['reason']}")
            print()
        
        print("-"*70)
        print("\nKey Recommendations:")
        self._display_recommendations()
        print("\n" + "="*70 + "\n")
    
    def _display_recommendations(self):
        """Display improvement recommendations based on scores"""
        weak_areas = [
            (name, data) for name, data in self.scores.items() 
            if data["score"] < 0.7
        ]
        
        if not weak_areas:
            print("  Great job! All areas meet or exceed expectations.")
            return
        
        weak_areas.sort(key=lambda x: x[1]["score"])
        
        for name, data in weak_areas[:3]:  # Top 3 areas for improvement
            print(f"  • {name}: Focus on improvement (Current: {data['score']*100:.1f}%)")


class EvaluationEngine:
    """Main evaluation engine for training sessions"""
    
    def __init__(self, evaluations_dir: str = "evaluations"):
        self.evaluations_dir = Path(evaluations_dir)
        self.evaluations_dir.mkdir(exist_ok=True)
        
        # Define evaluation weights (must sum to 1.0)
        self.metric_weights = {
            "Empathy & Tone": 0.25,
            "Policy Knowledge": 0.25,
            "Problem Resolution": 0.20,
            "Communication Clarity": 0.15,
            "Compliance": 0.15
        }
    
    async def evaluate_session(self, session_recording: SessionRecording) -> EvaluationReport:
        """
        Evaluate a completed training session
        
        Args:
            session_recording: The recorded session to evaluate
            
        Returns:
            EvaluationReport with detailed scores and feedback
        """
        logger.info("Starting evaluation for session %s", session_recording.session_id)
        
        report = EvaluationReport(session_recording)
        
        # Prepare transcript for evaluation
        transcript = self._format_transcript(session_recording)
        
        # Prepare input data for evaluators
        evaluation_input = {
            "scenario_id": session_recording.scenario_id,
            "scenario_name": session_recording.scenario_name,
            "customer_mood": session_recording.customer_mood,
            "difficulty": session_recording.difficulty,
            "context": session_recording.metadata.get("context", ""),
            "success_criteria": session_recording.metadata.get("success_criteria", [])
        }
        
        # Run all evaluators
        logger.info("Running evaluators...")

        # Empathy evaluation - HYBRID: Text (50%) + Audio (50%)
        logger.info("Evaluating empathy & tone (text analysis)")
        empathy_text_result = await self._evaluate_empathy(evaluation_input, transcript)
        
        logger.info("Evaluating empathy & tone (audio analysis)")
        audio_evaluator = AudioEmpathyEvaluator()
        empathy_audio_result = audio_evaluator.evaluate(session_recording)
        
        # Combine text and audio empathy scores
        combined_empathy_score = (empathy_text_result.score * 0.5) + (empathy_audio_result['score'] * 0.5)
        combined_empathy_reason = f"Text Analysis: {empathy_text_result.reason}\n\nAudio Analysis: {empathy_audio_result['reason']}"
        
        report.add_metric_score(
            "Empathy & Tone",
            combined_empathy_score,
            combined_empathy_reason,
            self.metric_weights["Empathy & Tone"]
        )
        
        # Policy knowledge evaluation
        logger.info("Evaluating policy knowledge")
        policy_result = await self._evaluate_policy_knowledge(evaluation_input, transcript)
        report.add_metric_score(
            "Policy Knowledge",
            policy_result.score,
            policy_result.reason,
            self.metric_weights["Policy Knowledge"]
        )
        
        # Resolution evaluation
        logger.info("Evaluating problem resolution")
        resolution_result = await self._evaluate_resolution(evaluation_input, transcript)
        report.add_metric_score(
            "Problem Resolution",
            resolution_result.score,
            resolution_result.reason,
            self.metric_weights["Problem Resolution"]
        )
        
        # Communication clarity evaluation
        logger.info("Evaluating communication clarity")
        clarity_result = await self._evaluate_clarity(evaluation_input, transcript)
        report.add_metric_score(
            "Communication Clarity",
            clarity_result.score,
            clarity_result.reason,
            self.metric_weights["Communication Clarity"]
        )
        
        # Compliance evaluation
        logger.info("Evaluating compliance")
        compliance_result = await self._evaluate_compliance(evaluation_input, transcript)
        report.add_metric_score(
            "Compliance",
            compliance_result.score,
            compliance_result.reason,
            self.metric_weights["Compliance"]
        )
        
        # Calculate overall score
        report.calculate_overall_score()
        
        # Save report
        self._save_report(report)
        
        logger.info("Evaluation complete!")
        return report
    
    def _format_transcript(self, session_recording: SessionRecording) -> str:
        """Format transcript for evaluation"""
        lines = []
        for turn in session_recording.transcript:
            speaker_label = turn.speaker.upper()
            lines.append(f"{speaker_label}: {turn.text}")
        return "\n".join(lines)
    
    async def _evaluate_empathy(self, input_data: Dict, transcript: str):
        """Run empathy evaluation"""
        evaluator = EmpathyScoreEvaluator()
        from strands_evals.types.evaluation import EvaluationData
        
        eval_data = EvaluationData(
            input=input_data,
            actual_output=transcript
        )
        results = await evaluator.evaluate_async(eval_data)
        return results[0]
    
    async def _evaluate_policy_knowledge(self, input_data: Dict, transcript: str):
        """Run policy knowledge evaluation"""
        evaluator = PolicyKnowledgeEvaluator()
        from strands_evals.types.evaluation import EvaluationData
        
        eval_data = EvaluationData(
            input=input_data,
            actual_output=transcript
        )
        results = await evaluator.evaluate_async(eval_data)
        return results[0]
    
    async def _evaluate_resolution(self, input_data: Dict, transcript: str):
        """Run resolution evaluation"""
        evaluator = ResolutionPathEvaluator()
        from strands_evals.types.evaluation import EvaluationData
        
        eval_data = EvaluationData(
            input=input_data,
            actual_output=transcript
        )
        results = await evaluator.evaluate_async(eval_data)
        return results[0]
    
    async def _evaluate_clarity(self, input_data: Dict, transcript: str):
        """Run clarity evaluation"""
        evaluator = CommunicationClarityEvaluator()
        from strands_evals.types.evaluation import EvaluationData
        
        eval_data = EvaluationData(
            input=input_data,
            actual_output=transcript
        )
        results = await evaluator.evaluate_async(eval_data)
        return results[0]
    
    async def _evaluate_compliance(self, input_data: Dict, transcript: str):
        """Run compliance evaluation"""
        evaluator = ComplianceEvaluator()
        from strands_evals.types.evaluation import EvaluationData
        
        eval_data = EvaluationData(
            input=input_data,
            actual_output=transcript
        )
        results = await evaluator.evaluate_async(eval_data)
        return results[0]
    
    def _save_report(self, report: EvaluationReport):
        """Save evaluation report to file"""
        report_path = self.evaluations_dir / f"{report.session_id}_evaluation.json"
        
        with open(report_path, 'w', encoding='utf-8') as f:
            json.dump(report.to_dict(), f, indent=2, ensure_ascii=False)
        
        logger.info("Report saved to %s", report_path)
