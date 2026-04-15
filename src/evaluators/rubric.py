"""Medical insurance evaluation rubric and custom evaluators"""
import os
from typing import List, Optional

from src.config.models import EVALUATION_MODEL_ID
from strands import Agent
from strands_evals.evaluators import Evaluator
from strands_evals.types.evaluation import EvaluationData, EvaluationOutput
from typing_extensions import TypeVar

InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")


class EmpathyScoreEvaluator(Evaluator[InputT, OutputT]):
    """Evaluates empathy and tone in agent responses"""
    
    def __init__(self, model: Optional[str] = None):
        super().__init__()
        self.model = model or os.getenv("EVALUATION_MODEL", EVALUATION_MODEL_ID)
    
    def evaluate(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Evaluate empathy and emotional intelligence"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of customer service empathy and emotional intelligence.

**IMPORTANT**: This is a raw speech-to-text transcript. The agent's text may have lowercase letters and minimal punctuation due to transcription. Evaluate the CONTENT and COMMUNICATION INTENT, not transcription formatting.

Evaluate the agent's responses on a 0.0 to 1.0 scale based on:
- Recognition of customer emotions
- Use of empathetic language
- Validation of customer concerns
- Appropriate tone matching customer's emotional state
- Avoiding dismissive or robotic responses

Scoring guide:
1.0 = Excellent empathy, deeply understands emotions, validates concerns effectively
0.7-0.9 = Good empathy, shows understanding, mostly appropriate responses
0.4-0.6 = Adequate empathy, some understanding but could be warmer
0.1-0.3 = Poor empathy, mechanical responses, dismissive of emotions
0.0 = No empathy, inappropriate or cold responses

Provide specific examples from the conversation to support your score.""",
            callback_handler=None
        )
        
        # Extract transcript from actual_output
        transcript = str(evaluation_case.actual_output)
        customer_mood = evaluation_case.input.get("customer_mood", "unknown") if isinstance(evaluation_case.input, dict) else "unknown"
        
        prompt = f"""Customer Mood: {customer_mood}

Conversation Transcript:
{transcript}

Evaluate the agent's empathy and emotional tone. Focus on how they respond to the customer's emotional state."""
        
        result = judge.structured_output(EvaluationOutput, prompt)
        return [result]
    
    async def evaluate_async(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Async version of evaluate"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of customer service empathy and emotional intelligence.

Evaluate the agent's responses on a 0.0 to 1.0 scale based on:
- Recognition of customer emotions
- Use of empathetic language
- Validation of customer concerns
- Appropriate tone matching customer's emotional state
- Avoiding dismissive or robotic responses

Scoring guide:
1.0 = Excellent empathy, deeply understands emotions, validates concerns effectively
0.7-0.9 = Good empathy, shows understanding, mostly appropriate responses
0.4-0.6 = Adequate empathy, some understanding but could be warmer
0.1-0.3 = Poor empathy, mechanical responses, dismissive of emotions
0.0 = No empathy, inappropriate or cold responses

Provide specific examples from the conversation to support your score.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        customer_mood = evaluation_case.input.get("customer_mood", "unknown") if isinstance(evaluation_case.input, dict) else "unknown"
        
        prompt = f"""Customer Mood: {customer_mood}

Conversation Transcript:
{transcript}

Evaluate the agent's empathy and emotional tone. Focus on how they respond to the customer's emotional state."""
        
        result = await judge.structured_output_async(EvaluationOutput, prompt)
        return [result]


class PolicyKnowledgeEvaluator(Evaluator[InputT, OutputT]):
    """Evaluates accuracy and appropriateness of insurance policy information"""
    
    def __init__(self, model: Optional[str] = None):
        super().__init__()
        self.model = model or os.getenv("EVALUATION_MODEL", EVALUATION_MODEL_ID)
    
    def evaluate(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Evaluate insurance policy knowledge"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of medical insurance knowledge and policy explanations.

Evaluate the agent's policy knowledge on a 0.0 to 1.0 scale based on:
- Accuracy of insurance terms and concepts
- Correct explanation of coverage, deductibles, copays, out-of-pocket maximums
- Understanding of claims process
- Awareness of pre-authorization requirements
- Accurate information about in-network vs out-of-network

Scoring guide:
1.0 = Perfect accuracy, comprehensive explanations, no errors
0.7-0.9 = Good knowledge, minor gaps but fundamentally correct
0.4-0.6 = Adequate knowledge, some confusion or incomplete info
0.1-0.3 = Poor knowledge, significant errors or misinformation
0.0 = Incorrect information that could mislead customer

Provide specific examples of correct or incorrect information.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        scenario_context = evaluation_case.input.get("context", "") if isinstance(evaluation_case.input, dict) else ""
        
        prompt = f"""Scenario Context: {scenario_context}

Conversation Transcript:
{transcript}

Evaluate the agent's insurance policy knowledge and accuracy of information provided."""
        
        result = judge.structured_output(EvaluationOutput, prompt)
        return [result]
    
    async def evaluate_async(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Async version of evaluate"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of medical insurance knowledge and policy explanations.

Evaluate the agent's policy knowledge on a 0.0 to 1.0 scale based on:
- Accuracy of insurance terms and concepts
- Correct explanation of coverage, deductibles, copays, out-of-pocket maximums
- Understanding of claims process
- Awareness of pre-authorization requirements
- Accurate information about in-network vs out-of-network

Scoring guide:
1.0 = Perfect accuracy, comprehensive explanations, no errors
0.7-0.9 = Good knowledge, minor gaps but fundamentally correct
0.4-0.6 = Adequate knowledge, some confusion or incomplete info
0.1-0.3 = Poor knowledge, significant errors or misinformation
0.0 = Incorrect information that could mislead customer

Provide specific examples of correct or incorrect information.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        scenario_context = evaluation_case.input.get("context", "") if isinstance(evaluation_case.input, dict) else ""
        
        prompt = f"""Scenario Context: {scenario_context}

Conversation Transcript:
{transcript}

Evaluate the agent's insurance policy knowledge and accuracy of information provided."""
        
        result = await judge.structured_output_async(EvaluationOutput, prompt)
        return [result]


class ResolutionPathEvaluator(Evaluator[InputT, OutputT]):
    """Evaluates problem-solving approach and resolution steps"""
    
    def __init__(self, model: Optional[str] = None):
        super().__init__()
        self.model = model or os.getenv("EVALUATION_MODEL", EVALUATION_MODEL_ID)
    
    def evaluate(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Evaluate problem resolution approach"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of customer service problem resolution.

Evaluate the agent's problem-solving on a 0.0 to 1.0 scale based on:
- Clear identification of the customer's issue
- Logical troubleshooting or investigation steps
- Providing actionable solutions or next steps
- Setting clear expectations about timeline
- Following up appropriately
- Offering alternatives when needed

Scoring guide:
1.0 = Excellent resolution, clear path forward, comprehensive solution
0.7-0.9 = Good resolution, effective approach with minor gaps
0.4-0.6 = Adequate resolution, basic solution but lacking detail
0.1-0.3 = Poor resolution, vague or incomplete solutions
0.0 = No resolution, failed to address the problem

Provide specific examples of effective or ineffective problem-solving.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        success_criteria = evaluation_case.input.get("success_criteria", []) if isinstance(evaluation_case.input, dict) else []
        
        prompt = f"""Success Criteria for Resolution:
{chr(10).join(f'- {c}' for c in success_criteria) if success_criteria else 'General problem resolution'}

Conversation Transcript:
{transcript}

Evaluate whether the agent provided a clear resolution path and met the success criteria."""
        
        result = judge.structured_output(EvaluationOutput, prompt)
        return [result]
    
    async def evaluate_async(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Async version of evaluate"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of customer service problem resolution.

Evaluate the agent's problem-solving on a 0.0 to 1.0 scale based on:
- Clear identification of the customer's issue
- Logical troubleshooting or investigation steps
- Providing actionable solutions or next steps
- Setting clear expectations about timeline
- Following up appropriately
- Offering alternatives when needed

Scoring guide:
1.0 = Excellent resolution, clear path forward, comprehensive solution
0.7-0.9 = Good resolution, effective approach with minor gaps
0.4-0.6 = Adequate resolution, basic solution but lacking detail
0.1-0.3 = Poor resolution, vague or incomplete solutions
0.0 = No resolution, failed to address the problem

Provide specific examples of effective or ineffective problem-solving.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        success_criteria = evaluation_case.input.get("success_criteria", []) if isinstance(evaluation_case.input, dict) else []
        
        prompt = f"""Success Criteria for Resolution:
{chr(10).join(f'- {c}' for c in success_criteria) if success_criteria else 'General problem resolution'}

Conversation Transcript:
{transcript}

Evaluate whether the agent provided a clear resolution path and met the success criteria."""
        
        result = await judge.structured_output_async(EvaluationOutput, prompt)
        return [result]


class CommunicationClarityEvaluator(Evaluator[InputT, OutputT]):
    """Evaluates clarity and effectiveness of communication"""
    
    def __init__(self, model: Optional[str] = None):
        super().__init__()
        self.model = model or os.getenv("EVALUATION_MODEL", EVALUATION_MODEL_ID)
    
    def evaluate(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Evaluate communication clarity"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of customer service communication clarity.

**IMPORTANT**: This is a raw speech-to-text transcript. The agent's text may have lowercase letters and minimal punctuation due to transcription. Evaluate the CONTENT CLARITY and COMMUNICATION EFFECTIVENESS, not transcription formatting.

Evaluate the agent's communication on a 0.0 to 1.0 scale based on:
- Clear and simple explanations
- Avoiding jargon or explaining technical terms
- Appropriate pacing and information chunking
- Confirming customer understanding
- Summarizing key points
- Active listening and acknowledgment

Scoring guide:
1.0 = Crystal clear, easy to understand, perfectly paced
0.7-0.9 = Good clarity, mostly clear with minor confusion
0.4-0.6 = Adequate clarity, some confusing elements
0.1-0.3 = Poor clarity, hard to follow or overly complex
0.0 = Unclear, confusing, or overwhelming communication

Provide specific examples of clear or unclear communication.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        
        prompt = f"""Conversation Transcript:
{transcript}

Evaluate the clarity and effectiveness of the agent's communication style."""
        
        result = judge.structured_output(EvaluationOutput, prompt)
        return [result]
    
    async def evaluate_async(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Async version of evaluate"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of customer service communication clarity.

**IMPORTANT**: This is a raw speech-to-text transcript. The agent's text may have lowercase letters and minimal punctuation due to transcription. Evaluate the CONTENT CLARITY and COMMUNICATION EFFECTIVENESS, not transcription formatting.

Evaluate the agent's communication on a 0.0 to 1.0 scale based on:
- Clear and simple explanations
- Avoiding jargon or explaining technical terms
- Appropriate pacing and information chunking
- Confirming customer understanding
- Summarizing key points
- Active listening and acknowledgment

Scoring guide:
1.0 = Crystal clear, easy to understand, perfectly paced
0.7-0.9 = Good clarity, mostly clear with minor confusion
0.4-0.6 = Adequate clarity, some confusing elements
0.1-0.3 = Poor clarity, hard to follow or overly complex
0.0 = Unclear, confusing, or overwhelming communication

Provide specific examples of clear or unclear communication.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        
        prompt = f"""Conversation Transcript:
{transcript}

Evaluate the clarity and effectiveness of the agent's communication style."""
        
        result = await judge.structured_output_async(EvaluationOutput, prompt)
        return [result]


class ComplianceEvaluator(Evaluator[InputT, OutputT]):
    """Evaluates HIPAA and regulatory compliance"""
    
    def __init__(self, model: Optional[str] = None):
        super().__init__()
        self.model = model or os.getenv("EVALUATION_MODEL", EVALUATION_MODEL_ID)
    
    def evaluate(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Evaluate compliance with regulations"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of healthcare and insurance regulatory compliance.

Evaluate the agent's compliance on a 0.0 to 1.0 scale based on:
- HIPAA compliance (privacy, data protection)
- Appropriate verification before sharing information
- Avoiding guarantees about coverage without verification
- Following proper escalation procedures
- Documenting interactions appropriately
- Not making unauthorized commitments

Scoring guide:
1.0 = Perfect compliance, all protocols followed
0.7-0.9 = Good compliance, minor procedural gaps
0.4-0.6 = Adequate compliance, some protocol violations
0.1-0.3 = Poor compliance, significant violations
0.0 = Non-compliant, serious regulatory risks

Flag any potential compliance violations.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        
        prompt = f"""Conversation Transcript:
{transcript}

Evaluate the agent's compliance with HIPAA and insurance regulations."""
        
        result = judge.structured_output(EvaluationOutput, prompt)
        return [result]
    
    async def evaluate_async(self, evaluation_case: EvaluationData[InputT, OutputT]) -> list[EvaluationOutput]:
        """Async version of evaluate"""
        judge = Agent(
            model=self.model,
            system_prompt="""You are an expert evaluator of healthcare and insurance regulatory compliance.

Evaluate the agent's compliance on a 0.0 to 1.0 scale based on:
- HIPAA compliance (privacy, data protection)
- Appropriate verification before sharing information
- Avoiding guarantees about coverage without verification
- Following proper escalation procedures
- Documenting interactions appropriately
- Not making unauthorized commitments

Scoring guide:
1.0 = Perfect compliance, all protocols followed
0.7-0.9 = Good compliance, minor procedural gaps
0.4-0.6 = Adequate compliance, some protocol violations
0.1-0.3 = Poor compliance, significant violations
0.0 = Non-compliant, serious regulatory risks

Flag any potential compliance violations.""",
            callback_handler=None
        )
        
        transcript = str(evaluation_case.actual_output)
        
        prompt = f"""Conversation Transcript:
{transcript}

Evaluate the agent's compliance with HIPAA and insurance regulations."""
        
        result = await judge.structured_output_async(EvaluationOutput, prompt)
        return [result]
